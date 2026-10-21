// Device configuration owns mutations only. Dialogs, connection batches and
// live sessions keep their existing owners and share the page's current state.
export class DeviceConfigurationController {
  constructor({
    state,
    request,
    refreshDevices,
    isDeviceBusy,
    isDeviceConnecting,
    confirmRemoveTemp,
    onChange,
    notify,
    onDeviceSaved,
    onDeviceError,
    onTempError,
  }) {
    this.state = state;
    this.request = request;
    this.refreshDevices = refreshDevices;
    this.isDeviceBusy = isDeviceBusy;
    this.isDeviceConnecting = isDeviceConnecting;
    this.confirmRemoveTemp = confirmRemoveTemp;
    this.onChange = onChange;
    this.notify = notify;
    this.onDeviceSaved = onDeviceSaved;
    this.onDeviceError = onDeviceError;
    this.onTempError = onTempError;
    // Preserve a request started before the deferred module was installed.
    if (state.activeOperation === undefined) state.activeOperation = null;
  }

  canStartOperation() {
    return this.state.isLoaded && !this.state.isLoading && !this.state.activeOperation;
  }

  getDevice(deviceId) {
    return this.state.devices.find((device) => device.id === deviceId);
  }

  isTargetBusy(deviceId) {
    return this.isDeviceConnecting(deviceId) || this.isDeviceBusy(deviceId);
  }

  beginOperation() {
    const operation = {
      generation: this.state.generation,
      abortController: new AbortController(),
    };
    this.state.activeOperation = operation;
    this.state.isLoading = true;
    return operation;
  }

  isCurrentOperation(operation) {
    return (
      this.state.activeOperation === operation && this.state.generation === operation.generation
    );
  }

  finishOperation(operation) {
    if (!this.isCurrentOperation(operation)) return;
    this.state.activeOperation = null;
    this.state.isLoading = false;
    this.onChange();
  }

  invalidate() {
    const operation = this.state.activeOperation;
    if (!operation) return;
    this.state.activeOperation = null;
    operation.abortController.abort();
    this.state.isLoading = false;
  }

  async refreshAfterOperation(operation, failureMessage) {
    if (!this.isCurrentOperation(operation)) return false;
    try {
      const refreshed = await this.refreshDevices();
      if (!this.isCurrentOperation(operation)) return false;
      if (refreshed === false) {
        this.notify(failureMessage + '：请检查访问密钥或服务端连接', 'error');
        return false;
      }
      return true;
    } catch (error) {
      if (this.isCurrentOperation(operation)) {
        this.notify(failureMessage + '：' + error.message, 'error');
      }
      return false;
    }
  }

  async saveDevice(deviceId, payload) {
    if (!this.canStartOperation()) return false;
    const isEditing = deviceId !== null && deviceId !== undefined;
    if (isEditing && !this.getDevice(deviceId)) {
      this.onDeviceError('设备已从列表移除');
      return false;
    }
    if (isEditing && this.isTargetBusy(deviceId)) {
      this.onDeviceError(
        '该设备正处于本轮投屏或启动中，请先停止此路再修改；新建其它设备不受限制。',
      );
      return false;
    }
    const operation = this.beginOperation();
    try {
      this.onChange();
      if (!this.isCurrentOperation(operation)) return false;
      const path = isEditing ? '/api/devices/' + encodeURIComponent(deviceId) : '/api/devices';
      const response = await this.request(path, {
        method: isEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: operation.abortController.signal,
      });
      if (!this.isCurrentOperation(operation)) return false;
      const saved = await response.json();
      if (!this.isCurrentOperation(operation)) return false;
      if (!saved?.id || (isEditing && saved.id !== deviceId)) {
        throw Error('设备保存响应与当前设备不一致');
      }
      if (isEditing && !this.getDevice(deviceId)) return false;
      this.state.selectedDeviceId = saved.id;
      this.onDeviceSaved(saved);
      this.notify('设备已保存', 'ok');
      await this.refreshAfterOperation(operation, '设备已保存，但列表刷新失败');
      return this.isCurrentOperation(operation);
    } catch (error) {
      if (this.isCurrentOperation(operation)) this.onDeviceError(error.message);
      return false;
    } finally {
      this.finishOperation(operation);
    }
  }

  async saveTempAddress(deviceId, ip, port) {
    if (!this.canStartOperation() || !this.getDevice(deviceId) || this.isTargetBusy(deviceId)) {
      return false;
    }
    const operation = this.beginOperation();
    try {
      this.onChange();
      this.notify('正在保存临时线路…');
      if (!this.isCurrentOperation(operation)) return false;
      await this.request('/api/devices/' + encodeURIComponent(deviceId) + '/temp-address', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, port }),
        signal: operation.abortController.signal,
      });
      if (!this.isCurrentOperation(operation)) return false;
      const refreshed = await this.refreshAfterOperation(
        operation,
        '临时线路已保存，但列表刷新失败',
      );
      if (!this.isCurrentOperation(operation)) return false;
      if (refreshed) {
        this.notify(
          ip
            ? '临时 IP 与共用端口已保存；请选择 IP 或点击加载/刷新设备后连接'
            : '临时 IP 已移除，共用端口保持不变',
          'ok',
        );
      }
      return true;
    } catch (error) {
      if (!this.isCurrentOperation(operation)) return false;
      this.notify(error.message, 'error');
      this.onTempError(error.message);
      await this.refreshAfterOperation(operation, '临时线路保存失败，列表刷新也失败');
      return false;
    } finally {
      this.finishOperation(operation);
    }
  }

  async removeTempAddress(deviceId) {
    const device = this.getDevice(deviceId);
    if (!this.canStartOperation() || !device || this.isTargetBusy(deviceId)) return false;
    const generation = this.state.generation;
    if (
      !this.confirmRemoveTemp(
        '确认移除「' +
          device.name +
          '」的临时 IP？ADB 共用端口保持不变，不会执行 ADB 断开或自动连接。',
      )
    )
      return false;
    // A confirmation callback can outlive the device or its credential state.
    if (generation !== this.state.generation) return false;
    return this.saveTempAddress(deviceId, null, null);
  }

  async switchRoute(deviceId, route) {
    if (!this.canStartOperation()) return false;
    if (this.isDeviceConnecting(deviceId)) {
      this.notify('该设备仍在连接中，请完成后再切换线路。', 'error');
      return false;
    }
    if (this.isDeviceBusy(deviceId)) {
      this.notify('这台设备正在投屏或启动中，请先停止此路再切换其连接地址。', 'error');
      return false;
    }
    const current = this.getDevice(deviceId);
    if (!current) return false;
    const originalRoute = current.selected_route;
    const originalSerial = current.selected_serial;
    let selectedSerial = current.selected_serial;
    // D1 may refresh metadata while connecting other devices. Both the original
    // snapshot and this mutation's confirmed target belong to this operation.
    const hasCurrentAddress = (device) =>
      device &&
      ((device.selected_route === originalRoute && device.selected_serial === originalSerial) ||
        (device.selected_route === route && device.selected_serial === selectedSerial));
    const operation = this.beginOperation();
    let isSuccessful = false;
    try {
      this.onChange();
      this.notify('正在保存当前连接地址…');
      if (!this.isCurrentOperation(operation)) return false;
      if (current.selected_route !== route) {
        const response = await this.request(
          '/api/devices/' + encodeURIComponent(deviceId) + '/route',
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ route }),
            signal: operation.abortController.signal,
          },
        );
        if (!this.isCurrentOperation(operation)) return false;
        const saved = await response.json();
        if (!this.isCurrentOperation(operation)) return false;
        if (saved?.id !== deviceId || saved.selected_route !== route || !saved.selected_serial) {
          throw Error('线路保存响应与当前设备不一致');
        }
        selectedSerial = saved.selected_serial;
        if (!hasCurrentAddress(this.getDevice(deviceId))) {
          throw Error('设备连接地址已变更，请重新选择线路');
        }
        this.state.devices = this.state.devices.map((device) =>
          device.id === deviceId ? saved : device,
        );
        this.onChange();
      }
      // Recheck after PUT/JSON/render. Ignore this operation's own page lock.
      const target = this.getDevice(deviceId);
      if (!hasCurrentAddress(target)) {
        throw Error('设备连接地址已变更，请重新选择线路');
      }
      if (this.isTargetBusy(deviceId)) throw Error('设备正在连接或投屏，本次连接已跳过');
      if (!this.isCurrentOperation(operation)) return false;
      const response = await this.request(
        '/api/devices/' + encodeURIComponent(deviceId) + '/connect',
        {
          method: 'POST',
          signal: operation.abortController.signal,
        },
      );
      if (!this.isCurrentOperation(operation)) return false;
      const connected = await response.json();
      if (!this.isCurrentOperation(operation)) return false;
      const present = this.getDevice(deviceId);
      if (!hasCurrentAddress(present)) {
        throw Error('设备连接地址已变更，请重新选择线路');
      }
      if (
        connected?.id !== deviceId ||
        connected.selected_serial !== selectedSerial ||
        connected.selected_route !== route
      ) {
        throw Error('连接响应与当前设备地址不一致');
      }
      this.state.devices = this.state.devices.map((device) =>
        device.id === deviceId ? connected : device,
      );
      this.notify(
        '已切换为' +
          ({ lan: '内网 IP', temp: '临时 IP', mesh: '组网 IP' }[route] || '所选线路') +
          '并连接 ' +
          connected.selected_serial,
        'ok',
      );
      isSuccessful = true;
    } catch (error) {
      if (this.isCurrentOperation(operation))
        this.notify('地址切换/连接：' + error.message, 'error');
    } finally {
      await this.refreshAfterOperation(operation, '地址切换/连接后列表刷新失败');
      if (!this.isCurrentOperation(operation)) isSuccessful = false;
      this.finishOperation(operation);
    }
    return isSuccessful;
  }
}

export function createDeviceConfigurationController(options) {
  return new DeviceConfigurationController(options);
}
