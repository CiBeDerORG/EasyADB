import { createApiClient } from '../core/api-client.js';
import { createDomHelpers } from '../shared/dom.js';
import { createDialogController } from '../shared/ui/dialog.js';
import { createToastController } from '../shared/ui/toast.js';
import { createInventoryDrawer } from '../shared/ui/inventory-drawer.js';
import { createLiveSessionController } from '../features/live/live-session-controller.js';
import { createLiveQualitySettings } from '../features/live/live-quality-settings.js';
import { createLiveBatchScheduler } from '../features/live/live-batch-scheduler.js';
import { createLiveCardView } from '../features/live/live-card-view.js';
import { createDeviceConnectionController } from '../features/devices/device-connection-controller.js';
import { createDeviceManagementController } from '../features/devices/device-management-controller.js';
import { createDeviceConfigurationController } from '../features/devices/device-configuration-controller.js';
import { createDeviceDialogController } from '../features/devices/device-dialog-controller.js';
import { createGroupDialogController } from '../features/devices/group-dialog-controller.js';
import { renderDiscoveryResult } from '../features/devices/group-discovery-view.js';
import { renderDeviceManagement } from '../features/devices/device-management-view.js';

const pages = new WeakMap();

// Configuration and group controllers use the same field name for distinct
// operation owners. Accessors share page state without copying it.
function operationState(state, ownerKey) {
  const view = {};
  for (const key of [...Object.keys(state), 'activeOperation']) {
    const sharedKey = key === 'activeOperation' ? ownerKey : key;
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => state[sharedKey],
      set: (value) => {
        state[sharedKey] = value;
      },
    });
  }
  return view;
}

// The only page assembly. Construction binds controls without loading devices,
// connecting ADB or scanning routers. One document has one state/event owner.
export function createPageController({
  documentRef = document,
  windowRef = window,
  request = (path, options) => fetch(path, options),
  confirmAction = (text) => windowRef.confirm(text),
  storage,
  createMultiView = (options) => windowRef.EasyADBMulti.create(options),
  createGroupControl = (options) => windowRef.EasyADBGroup.create(options),
  createDisplayLab = (options) => windowRef.EasyADBDisplayLab.create(options),
} = {}) {
  if (pages.has(documentRef)) return pages.get(documentRef);
  const getElement = (id) => documentRef.getElementById(id);
  const getToken = () => getElement('token').value.trim();
  const state = {
    devices: [],
    groups: [],
    selectedDeviceId: null,
    isLoaded: false,
    isLoading: false,
    generation: 0,
    resultRevision: 0,
    metadataLoad: null,
    abortController: null,
    isBatchBusy: false,
    selectedDeviceIds: new Set(),
    pendingDeviceIds: new Set(),
    resultSnapshots: new Map(),
    activeBatch: null,
    configurationOperation: null,
    groupOperation: null,
    activePairOperation: null,
    editingDeviceId: null,
    editingTempDeviceId: null,
    pairingDeviceId: null,
    pairingSerial: null,
    deviceDialogRevision: 0,
    tempDialogRevision: 0,
    firstPairDialogRevision: 0,
    editingGroupName: null,
    dialogRevision: 0,
    hasSavedDiscovery: false,
    scanningGroupNames: new Set(),
    scanOperations: new Map(),
    groupOpen: new Map(),
    needsLiveReset: false,
    liveResetOperation: null,
  };
  const api = createApiClient({ getToken, request });
  const dom = createDomHelpers({ documentRef });
  const dialog = createDialogController({ getElement });
  const toast = createToastController({ host: getElement('toastHost'), documentRef, windowRef });
  const inventoryDrawer = createInventoryDrawer({
    documentRef,
    storage: {
      getItem: (key) => (storage ?? windowRef.localStorage).getItem(key),
      setItem: (key, value) => (storage ?? windowRef.localStorage).setItem(key, value),
    },
  });
  const notify = (text, kind = '') => toast.showToast(text, { key: 'status', kind });
  let multiView = null;
  let displayLabView = null;
  const isDeviceConnecting = (id) => state.pendingDeviceIds.has(id);
  const isDeviceBusy = (id) => isDeviceConnecting(id) || Boolean(multiView?.isBusyFor(id));
  const isDeviceLocked = (id) => state.isLoading || isDeviceBusy(id);
  const controllers = {};

  function render() {
    // The hidden staging picker retains each device's quality settings.
    if (multiView) multiView.updatePicker(false);
    renderDeviceManagement({
      state,
      getElement,
      dom,
      selection: controllers.management.getSelectionSummary(),
      isDeviceConnecting,
      isDeviceLocked,
      ui: {
        hasProjection: Boolean(multiView),
        projectionButton: (device) => multiView.projectionButton(device),
        openProjectionSettings: (device) => multiView.openSettings(device),
        openDisplayLab: (id) => displayLabView.open(id),
      },
      on: {
        onSelectionChange: (id, checked) => controllers.management.selectDevice(id, checked),
        switchRoute: (id, route) => controllers.configuration.switchRoute(id, route),
        editDevice: (id) => controllers.deviceDialogs.openDevice(id),
        removeTempAddress: (id) => controllers.configuration.removeTempAddress(id),
        openFirstPair: (id) => controllers.deviceDialogs.openFirstPair(id),
        openTempEditor: (device) => controllers.deviceDialogs.openTemp(device.id),
        openGroup: (name) => controllers.groupDialogs.openGroup(name),
        scanGroup: (name) => controllers.groupDialogs.scanGroup(name),
      },
    });
  }

  const loadDevices = (quiet = false) => controllers.connection.loadDevices(quiet);
  controllers.connection = createDeviceConnectionController({
    state,
    request: api,
    getToken,
    isDeviceBusy: (id) => Boolean(multiView?.isBusyFor(id)),
    onChange: render,
    notify,
  });
  controllers.management = createDeviceManagementController({
    state,
    request: api,
    refreshDevices: () => loadDevices(true),
    confirmDelete: confirmAction,
    isDeviceBusy,
    isDeviceConnecting,
    onChange: render,
    notify,
  });
  controllers.configuration = createDeviceConfigurationController({
    state: operationState(state, 'configurationOperation'),
    request: api,
    refreshDevices: () => loadDevices(true),
    isDeviceBusy,
    isDeviceConnecting,
    confirmRemoveTemp: confirmAction,
    onChange: render,
    notify,
    onDeviceSaved: () => dialog.closeDialog('deviceDialog'),
    onDeviceError: (text) => dialog.modalMessage(text),
    onTempError: (text) => {
      if (!getElement('tempDialog').open) return;
      getElement('tempMessage').hidden = false;
      getElement('tempMessage').textContent = text;
    },
  });
  controllers.deviceDialogs = createDeviceDialogController({
    state,
    getElement,
    createElement: (tag) => documentRef.createElement(tag),
    dialog,
    saveDevice: (id, payload) => controllers.configuration.saveDevice(id, payload),
    saveTempAddress: (id, ip, port) => controllers.configuration.saveTempAddress(id, ip, port),
    request: api,
    isDeviceBusy,
    isDeviceConnecting,
    onChange: render,
    notify,
  });
  controllers.groupDialogs = createGroupDialogController({
    state: operationState(state, 'groupOperation'),
    getElement,
    dialog,
    request: api,
    refreshDevices: () => loadDevices(true),
    isDeviceBusy,
    isDeviceConnecting,
    confirmDelete: confirmAction,
    onChange: render,
    notify,
    dismissToast: toast.dismissToast,
    showScanResult: (name, result) => {
      const panel = renderDiscoveryResult(result, dom);
      panel.prepend(
        dom.elem('div', 'discovery-group-name', '「' + name + '」ADB 扫描结果 · 不自动连接或投屏'),
      );
      toast.showToast(panel, { key: 'discovery:' + name, kind: 'ok' });
    },
    showScanError: (name, text) =>
      toast.showToast('「' + name + '」发现失败：' + text, {
        key: 'discovery:' + name,
        kind: 'error',
      }),
  });

  async function resetPreviousLiveSessions() {
    if (!state.needsLiveReset) return true;
    if (!getToken()) {
      notify('请先输入访问密钥', 'error');
      return false;
    }
    const generation = state.generation;
    const existing = state.liveResetOperation;
    if (existing?.generation === generation) return existing.promise;
    const operation = { generation, promise: null };
    state.liveResetOperation = operation;
    operation.promise = (async () => {
      try {
        notify('访问密钥已更新，正在清理此前全部实时画面…');
        await api('/api/m2/live/reset', { method: 'POST' });
        if (state.generation !== generation || state.liveResetOperation !== operation) return false;
        state.needsLiveReset = false;
        notify('此前实时画面已全部清理，可以重新加载设备', 'ok');
        return true;
      } catch (error) {
        if (state.generation === generation && state.liveResetOperation === operation) {
          notify('此前实时画面清理未完成：' + error.message, 'error');
        }
        return false;
      } finally {
        if (state.liveResetOperation === operation) state.liveResetOperation = null;
      }
    })();
    return operation.promise;
  }

  async function loadAndConnect() {
    if (state.isLoading || state.isBatchBusy) return;
    const generation = state.generation;
    state.isBatchBusy = true;
    state.isLoading = true;
    render();
    let resetReady = false;
    let loaded = false;
    try {
      resetReady = await resetPreviousLiveSessions();
      if (generation === state.generation && resetReady) loaded = await loadDevices(true);
    } finally {
      if (generation === state.generation) {
        state.isLoading = false;
        render();
      }
    }
    if (generation !== state.generation) return;
    if (!resetReady) {
      state.isBatchBusy = false;
      render();
      return;
    }
    if (!loaded) {
      state.isBatchBusy = false;
      render();
      notify('设备列表加载失败，请检查访问密钥或服务端连接', 'error');
      return;
    }
    const candidates = state.devices.filter((device) => !isDeviceLocked(device.id));
    const skipped = state.devices.length - candidates.length;
    if (!candidates.length) {
      state.isBatchBusy = false;
      render();
      notify('设备列表已刷新；没有需要连接的空闲设备', 'ok');
      return;
    }
    notify('已加载设备，最多 4 台并发连接；每台完成后立即开放操作…');
    await controllers.connection.connectDevices(
      candidates,
      skipped,
      false,
      '首次加载连接',
      generation,
    );
  }

  async function connectSelected() {
    if (state.isLoading || state.isBatchBusy || !state.isLoaded) return;
    const selected = state.devices.filter((device) => state.selectedDeviceIds.has(device.id));
    const candidates = selected.filter((device) => !isDeviceLocked(device.id));
    if (!candidates.length) return;
    state.isBatchBusy = true;
    notify('批量连接：最多 4 台并发，成功设备立即勾选并开放操作…');
    await controllers.connection.connectDevices(
      candidates,
      selected.length - candidates.length,
      true,
      '批量连接',
      state.generation,
    );
  }

  function invalidate() {
    state.generation++;
    state.needsLiveReset = true;
    state.abortController?.abort();
    state.abortController = null;
    controllers.management.invalidate();
    controllers.configuration.invalidate();
    controllers.deviceDialogs.invalidate();
    controllers.groupDialogs.invalidate();
    displayLabView?.invalidate?.();
    state.pendingDeviceIds.clear();
    state.resultSnapshots.clear();
    if (state.isBatchBusy) state.isLoading = false;
    state.isBatchBusy = false;
    multiView.closeAll();
    state.isLoaded = false;
    state.devices = [];
    state.groups = [];
    state.selectedDeviceId = null;
    state.selectedDeviceIds.clear();
    render();
  }

  multiView = createMultiView({
    picker: getElement('multiPicker'),
    grid: getElement('multiGrid'),
    startButton: getElement('multiStart'),
    stopButton: getElement('multiStop'),
    info: getElement('multiInfo'),
    getDevices: () => state.devices,
    getToken,
    getManagementBusy: () => state.isLoading,
    getBatchSelection: () => state.selectedDeviceIds,
    onBatchSelectionRemove: (id) => {
      state.selectedDeviceIds.delete(id);
      render();
    },
    onProjectionStarted: () => inventoryDrawer.collapse(true),
    onOpenManagement: () => inventoryDrawer.expand(),
    onDeviceDisconnected: () => loadDevices(true),
    readUnlockSettings: async (id) =>
      (await api('/api/devices/' + encodeURIComponent(id) + '/unlock')).json(),
    saveUnlockSettings: async (id, password) =>
      (
        await api('/api/devices/' + encodeURIComponent(id) + '/unlock', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        })
      ).json(),
    runPreflight: async (id) =>
      (
        await api('/api/devices/' + encodeURIComponent(id) + '/m2/preflight', { method: 'POST' })
      ).json(),
    runVideoProbe: async (id, profile) =>
      (
        await api('/api/devices/' + encodeURIComponent(id) + '/m2/video-probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile }),
        })
      ).json(),
    onChange: render,
    featureModules: {
      createLiveSessionController,
      createLiveQualitySettings,
      createLiveBatchScheduler,
      createLiveCardView,
    },
  });
  multiView.groupControl = createGroupControl({
    view: multiView,
    host: getElement('groupControlHost'),
  });
  multiView.groupControl.refresh();
  displayLabView = createDisplayLab({
    dialog: getElement('displayLabDialog'),
    getDevice: (id) => state.devices.find((device) => device.id === id),
    getGeneration: () => state.generation,
    api,
    multiView,
  });
  controllers.deviceDialogs.bindEvents();
  controllers.groupDialogs.bindEvents();
  getElement('load').addEventListener('click', loadAndConnect);
  getElement('token').addEventListener('input', invalidate);
  getElement('token').addEventListener('change', () => resetPreviousLiveSessions());
  getElement('bulkSelectAll').addEventListener('change', () =>
    controllers.management.selectAll(getElement('bulkSelectAll').checked),
  );
  getElement('bulkConnect').addEventListener('click', connectSelected);
  getElement('bulkDelete').addEventListener('click', () => controllers.management.deleteSelected());
  getElement('refreshAll').addEventListener('click', () => controllers.management.checkSelected());
  for (const eventName of ['beforeunload', 'pagehide', 'offline']) {
    windowRef.addEventListener(eventName, () => multiView.closeAll());
  }
  const page = {
    state,
    controllers,
    render,
    loadDevices,
    loadAndConnect,
    connectSelected,
    resetPreviousLiveSessions,
    invalidate,
    multiView,
    inventoryDrawer,
    api,
    toast,
  };
  pages.set(documentRef, page);
  render();
  notify('请展开左侧设备管理，输入访问密钥并加载设备');
  return page;
}
