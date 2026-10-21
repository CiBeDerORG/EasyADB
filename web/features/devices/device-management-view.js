import { buildDeviceGroups, hasConnectedAdb } from './device-list-model.js';
import { renderDeviceGroups } from './device-list-view.js';

// One presentation path for the inventory and batch toolbar. Controllers own
// selection and operations; live ports own projection and its settings.
export function renderDeviceManagement({
  state,
  getElement,
  dom,
  selection,
  isDeviceConnecting,
  isDeviceLocked,
  ui,
  on,
}) {
  const { elem, action } = dom;
  const list = getElement('devices');
  list.replaceChildren();
  const { grouped, keys } = buildDeviceGroups(state.devices, state.groups);
  getElement('count').textContent = state.devices.length + ' 台设备 · ' + keys.length + ' 个分组';
  renderDeviceGroups({
    list,
    grouped,
    keys,
    state: {
      selectedId: state.selectedDeviceId,
      selectedDeviceIds: state.selectedDeviceIds,
      isLoading: state.isLoading,
      isLoaded: state.isLoaded,
      groupOpen: state.groupOpen,
      scanningGroups: state.scanningGroupNames,
      isDeviceConnecting,
      isDeviceLocked,
      hasConnectedAdb,
    },
    ui,
    on,
    elem,
    action,
  });
  if (!state.groups.length && !state.devices.length) {
    list.append(elem('p', 'hint', '暂无设备。点击「添加分组」或「添加设备」开始。'));
  }
  const { selected, eligible, ready, selectable, selectedSelectable } = selection;
  const unavailableCount = selected.length - ready.length;
  const busyCount = selected.length - eligible.length;
  getElement('newDevice').disabled = state.isLoading || !state.isLoaded;
  getElement('newGroup').disabled = state.isLoading || !state.isLoaded;
  getElement('refreshAll').disabled = state.isLoading || !state.isLoaded || !eligible.length;
  getElement('bulkCount').textContent =
    '已选设备 ' +
    selected.length +
    ' 台 · ADB 可用 ' +
    ready.length +
    ' 台' +
    (unavailableCount ? ' · 未连接/连接失败 ' + unavailableCount + ' 台' : '') +
    (busyCount ? ' · ' + busyCount + ' 台投屏中不可批量管理' : '');
  getElement('bulkConnect').disabled =
    state.isLoading || state.isBatchBusy || !state.isLoaded || !eligible.length;
  getElement('bulkDelete').disabled = state.isLoading || !state.isLoaded || !eligible.length;
  getElement('load').disabled = state.isLoading || state.isBatchBusy;
  const selectAll = getElement('bulkSelectAll');
  selectAll.disabled = state.isLoading || !state.isLoaded || !selectable.length;
  selectAll.checked = selectable.length > 0 && selectedSelectable.length === selectable.length;
  selectAll.indeterminate =
    selectedSelectable.length > 0 && selectedSelectable.length < selectable.length;
}
