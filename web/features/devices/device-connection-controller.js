import { hasConnectedAdb } from './device-list-model.js';

const CONNECT_CONCURRENCY = 4;

// Share the page's generation, pending IDs, selection and result revisions.
// This controller owns ADB loading/connection, without DOM, live sessions or polling.
export class DeviceConnectionController {
  constructor({ state, request, getToken, isDeviceBusy, onChange, notify }) {
    this.state = state;
    this.request = request;
    this.getToken = getToken;
    this.isDeviceBusy = isDeviceBusy;
    this.onChange = onChange;
    this.notify = notify;
    if (state.metadataLoad === undefined) state.metadataLoad = null;
  }

  async loadDevices(isQuiet = false) {
    const state = this.state;
    if (!this.getToken().trim()) {
      this.notify('请先输入访问密钥', 'error');
      return false;
    }
    const metadataLoad = {
      generation: state.generation,
      resultRevision: state.resultRevision,
      promise: null,
    };
    state.metadataLoad = metadataLoad;
    metadataLoad.promise = this.readDevices(metadataLoad, isQuiet);
    return metadataLoad.promise;
  }

  async readDevices(metadataLoad, isQuiet) {
    const state = this.state;
    const { generation, resultRevision } = metadataLoad;
    try {
      const [devices, groups] = await Promise.all([
        this.request('/api/devices').then((response) => response.json()),
        this.request('/api/groups').then((response) => response.json()),
      ]);
      if (generation !== state.generation) return false;
      // Only the newest read may publish a snapshot. An older caller follows
      // its replacement's result, so overlapping scans do not report a false
      // refresh failure, and a failed new read cannot revive stale deleted rows.
      if (state.metadataLoad !== metadataLoad) return state.metadataLoad?.promise ?? false;
      const merged = devices.map((device) => {
        const newer = state.resultSnapshots.get(device.id);
        return newer &&
          newer.revision > resultRevision &&
          newer.device.selected_serial === device.selected_serial
          ? newer.device
          : device;
      });
      state.devices = merged;
      state.groups = groups;
      state.isLoaded = true;
      const availableIds = new Set(merged.map((device) => device.id));
      if (state.selectedDeviceId && !availableIds.has(state.selectedDeviceId)) {
        state.selectedDeviceId = null;
      }
      for (const deviceId of state.selectedDeviceIds) {
        if (!availableIds.has(deviceId)) state.selectedDeviceIds.delete(deviceId);
      }
      this.onChange();
      if (!isQuiet) this.notify('已加载 ' + merged.length + ' 台设备', 'ok');
      return true;
    } catch (error) {
      // A replaced read's failure is as stale as its successful response.
      if (generation !== state.generation) return false;
      if (state.metadataLoad !== metadataLoad) return state.metadataLoad?.promise ?? false;
      if (!isQuiet) this.notify(error.message, 'error');
      return false;
    }
  }

  applyConnectionResult(device, result) {
    const state = this.state;
    const present = state.devices.find((entry) => entry.id === device.id);
    if (!present || present.selected_serial !== device.selected_serial) return false;
    const isValidResponse =
      result.status === 'fulfilled' &&
      result.value?.id === device.id &&
      result.value.selected_serial === device.selected_serial;
    const fresh = isValidResponse
      ? result.value
      : {
          ...present,
          status: 'error',
          active_serial: null,
          connect_failed: true,
          last_error: result.reason?.message || 'ADB 连接请求未完成',
        };
    state.resultRevision++;
    state.resultSnapshots.set(device.id, { revision: state.resultRevision, device: fresh });
    state.devices = state.devices.map((entry) => (entry.id === device.id ? fresh : entry));
    return hasConnectedAdb(fresh);
  }

  async connectDevices(candidates, skipped, shouldSelectSuccessful, label, generation) {
    const state = this.state;
    if (generation !== state.generation) return;
    const controller = new AbortController();
    state.abortController = controller;
    state.resultSnapshots.clear();
    if (shouldSelectSuccessful) state.selectedDeviceIds.clear();
    const deviceIds = new Set(candidates.map((device) => device.id));
    for (const deviceId of deviceIds) state.pendingDeviceIds.add(deviceId);
    state.devices = state.devices.map((device) =>
      deviceIds.has(device.id)
        ? {
            ...device,
            status: 'connecting',
            active_serial: null,
            connect_failed: false,
            last_error: null,
          }
        : device,
    );
    this.onChange();
    const isCurrentBatch = () =>
      generation === state.generation && state.abortController === controller;
    let success = 0;
    let failed = 0;
    try {
      await runConnectionBatch(
        candidates,
        async (device) => {
          if (!isCurrentBatch() || controller.signal.aborted) throw Error('连接任务已取消');
          if (this.isDeviceBusy(device.id)) throw Error('设备已经开始投屏，本次跳过');
          const response = await this.request(
            '/api/devices/' + encodeURIComponent(device.id) + '/connect',
            { method: 'POST', signal: controller.signal },
          );
          return response.json();
        },
        (completed, total, device, result) => {
          if (!isCurrentBatch()) return;
          state.pendingDeviceIds.delete(device.id);
          if (this.applyConnectionResult(device, result)) {
            success++;
            if (shouldSelectSuccessful) state.selectedDeviceIds.add(device.id);
          } else {
            failed++;
          }
          this.onChange();
          this.notify(
            label +
              '：已完成 ' +
              completed +
              ' / ' +
              total +
              ' 台，成功 ' +
              success +
              ' 台，失败/跳过 ' +
              failed +
              ' 台；已完成设备可立即操作',
          );
        },
      );
    } finally {
      if (isCurrentBatch()) {
        state.pendingDeviceIds.clear();
        try {
          // Metadata only, once per completed batch; never reconnect here.
          await this.loadDevices(true);
        } finally {
          if (isCurrentBatch()) {
            state.abortController = null;
            state.resultSnapshots.clear();
            state.isBatchBusy = false;
            this.onChange();
          }
        }
      }
    }
    if (generation !== state.generation) return;
    this.notify(
      label +
        '完成：成功 ' +
        success +
        ' 台，失败/跳过 ' +
        failed +
        ' 台，投屏中预先跳过 ' +
        skipped +
        ' 台；每台仅尝试一次，不自动切换线路。',
      failed ? 'error' : 'ok',
    );
  }
}

async function runConnectionBatch(devices, task, onProgress) {
  let next = 0;
  let completed = 0;
  const workers = Array.from(
    { length: Math.min(CONNECT_CONCURRENCY, devices.length) },
    async () => {
      while (next < devices.length) {
        const device = devices[next++];
        let result;
        try {
          result = { status: 'fulfilled', value: await task(device) };
        } catch (error) {
          result = { status: 'rejected', reason: error };
        }
        completed++;
        onProgress(completed, devices.length, device, result);
      }
    },
  );
  await Promise.all(workers);
}

export function createDeviceConnectionController(options) {
  return new DeviceConnectionController(options);
}
