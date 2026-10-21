import { hasConnectedAdb } from './device-list-model.js';

// Batch actions share the page's device array and selection Set with ADB and projection.
export class DeviceManagementController {
  constructor({
    state,
    request,
    refreshDevices,
    confirmDelete,
    isDeviceBusy,
    isDeviceConnecting,
    onChange,
    notify,
  }) {
    this.state = state;
    this.request = request;
    this.refreshDevices = refreshDevices;
    this.confirmDelete = confirmDelete;
    this.isDeviceBusy = isDeviceBusy;
    this.isDeviceConnecting = isDeviceConnecting;
    this.onChange = onChange;
    this.notify = notify;
    // The page also exposes this owner to the temporary inline adapter. Never
    // replace an in-flight legacy batch when the deferred module is installed.
    if (state.activeBatch === undefined) state.activeBatch = null;
  }

  get activeBatch() {
    return this.state.activeBatch;
  }

  set activeBatch(batch) {
    this.state.activeBatch = batch;
  }

  getSelectionSummary() {
    const state = this.state;
    const selected = state.devices.filter((device) => state.selectedDeviceIds.has(device.id));
    const eligible = selected.filter((device) => !state.isLoading && !this.isDeviceBusy(device.id));
    const selectable = state.devices.filter((device) => !this.isDeviceConnecting(device.id));
    return {
      selected,
      eligible,
      ready: selected.filter(hasConnectedAdb),
      selectable,
      selectedSelectable: selectable.filter((device) => state.selectedDeviceIds.has(device.id)),
    };
  }

  selectDevice(deviceId, shouldSelect) {
    const state = this.state;
    if (
      state.isLoading ||
      !state.isLoaded ||
      !state.devices.some((device) => device.id === deviceId) ||
      this.isDeviceConnecting(deviceId)
    )
      return;
    if (shouldSelect) state.selectedDeviceIds.add(deviceId);
    else state.selectedDeviceIds.delete(deviceId);
    this.onChange();
  }

  selectAll(shouldSelect) {
    if (this.state.isLoading || !this.state.isLoaded) return;
    for (const device of this.getSelectionSummary().selectable) {
      if (shouldSelect) this.state.selectedDeviceIds.add(device.id);
      else this.state.selectedDeviceIds.delete(device.id);
    }
    this.onChange();
  }

  invalidate() {
    const batch = this.activeBatch;
    if (!batch) return;
    this.activeBatch = null;
    batch.abortController.abort();
    // The credential-reset handler will clear the lists and redraw.
    this.state.isLoading = false;
  }

  async deleteSelected() {
    return this.runBatch('delete');
  }

  async checkSelected() {
    return this.runBatch('check');
  }

  async runBatch(operation) {
    const state = this.state;
    if (state.isLoading || !state.isLoaded || this.activeBatch) return false;
    const generation = state.generation;
    const { selected, eligible } = this.getSelectionSummary();
    const skipped = selected.length - eligible.length;
    if (!eligible.length) return false;
    if (
      operation === 'delete' &&
      !this.confirmDelete(
        '将从列表永久删除以下 ' +
          eligible.length +
          ' 台设备：\n' +
          eligible.map((device) => device.name).join('、') +
          (skipped ? '\n另有 ' + skipped + ' 台正在投屏或清理中，将跳过。' : '') +
          '\n不会清除手机上的 ADB 配对授权。确认删除？',
      )
    )
      return false;

    if (generation !== state.generation || state.isLoading || !state.isLoaded || this.activeBatch) {
      return false;
    }
    const batch = { generation, abortController: new AbortController() };
    const isCurrent = () => this.activeBatch === batch && state.generation === batch.generation;
    this.activeBatch = batch;
    state.isLoading = true;
    const failed = [];
    const deletedIds = new Set();
    let success = 0;
    let refreshFailed = false;
    let completed = false;

    try {
      this.onChange();
      for (const device of eligible) {
        if (!isCurrent()) return false;
        if (operation === 'check') {
          this.notify(
            '批量检查中 ' +
              (success + failed.length + 1) +
              ' / ' +
              eligible.length +
              '：' +
              device.name,
          );
        }
        // A phone may become busy or leave the selection during an earlier request.
        // Revalidate immediately before dispatch, ignoring the page's own lock.
        const present = state.devices.find((entry) => entry.id === device.id);
        if (!present || !state.selectedDeviceIds.has(device.id) || this.isDeviceBusy(device.id)) {
          failed.push(device.name + '：正在连接或投屏，已跳过');
          continue;
        }
        if (present.selected_serial !== device.selected_serial) {
          failed.push(device.name + '：设备选定地址已变更，已跳过');
          continue;
        }
        try {
          const response = await this.request(
            '/api/devices/' +
              encodeURIComponent(device.id) +
              (operation === 'check' ? '/refresh' : ''),
            {
              method: operation === 'check' ? 'POST' : 'DELETE',
              signal: batch.abortController.signal,
            },
          );
          if (!isCurrent()) return false;
          if (operation === 'check') {
            const fresh = await response.json();
            if (!isCurrent()) return false;
            const current = state.devices.find((entry) => entry.id === device.id);
            if (
              !current ||
              current.selected_serial !== device.selected_serial ||
              fresh?.id !== device.id ||
              fresh.selected_serial !== device.selected_serial
            ) {
              throw Error('设备检查结果与当前选定地址不一致，已忽略');
            }
            state.devices = state.devices.map((entry) => (entry.id === device.id ? fresh : entry));
          } else {
            state.selectedDeviceIds.delete(device.id);
            if (state.selectedDeviceId === device.id) state.selectedDeviceId = null;
            deletedIds.add(device.id);
          }
          success++;
        } catch (error) {
          if (!isCurrent()) return false;
          failed.push(device.name + '：' + error.message);
        }
      }
      if (!isCurrent()) return false;
      try {
        refreshFailed = (await this.refreshDevices()) !== true;
      } catch {
        refreshFailed = true;
      }
      if (!isCurrent()) return false;
      // A failed final GET should not resurrect successfully deleted devices.
      if (refreshFailed && deletedIds.size) {
        state.devices = state.devices.filter((device) => !deletedIds.has(device.id));
      }
      completed = true;
    } finally {
      if (isCurrent()) {
        this.activeBatch = null;
        state.isLoading = false;
        this.onChange();
      }
    }

    if (!completed) return false;
    const refreshWarning = refreshFailed ? '；设备列表刷新失败，请手动重新加载' : '';
    if (operation === 'delete') {
      this.notify(
        '批量删除完成：已删除 ' +
          success +
          ' 台，预先跳过投屏中 ' +
          skipped +
          ' 台，其他未删除 ' +
          failed.length +
          ' 台' +
          (failed.length ? '；' + failed.join('；') : '') +
          refreshWarning +
          '.',
        failed.length || refreshFailed ? 'error' : 'ok',
      );
    } else {
      this.notify(
        '批量检查完成：已检查 ' +
          success +
          ' 台，投屏中预先跳过 ' +
          skipped +
          ' 台，其他失败/跳过 ' +
          failed.length +
          ' 台；只检查各自选定地址，不自动连接' +
          (failed.length ? '；' + failed.join('；') : '') +
          refreshWarning,
        failed.length || refreshFailed ? 'error' : 'ok',
      );
    }
    return true;
  }
}

export function createDeviceManagementController(options) {
  return new DeviceManagementController(options);
}
