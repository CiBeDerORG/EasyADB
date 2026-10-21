// Device dialogs own their form sessions and explicit pairing requests. Device
// mutations continue through the injected configuration controller (D3).
export class DeviceDialogController {
  constructor({
    state,
    getElement,
    createElement,
    dialog,
    saveDevice,
    saveTempAddress,
    request,
    isDeviceBusy,
    isDeviceConnecting,
    onChange,
    notify,
  }) {
    this.state = state;
    this.getElement = getElement;
    this.createElement = createElement;
    this.dialog = dialog;
    this.saveDevice = saveDevice;
    this.saveTempAddress = saveTempAddress;
    this.request = request;
    this.isDeviceBusy = isDeviceBusy;
    this.isDeviceConnecting = isDeviceConnecting;
    this.onChange = onChange;
    this.notify = notify;
    this.hasBoundEvents = false;
    // The classic adapter may already have an open form or pairing request.
    if (state.activePairOperation === undefined) state.activePairOperation = null;
    for (const key of ['deviceDialogRevision', 'tempDialogRevision', 'firstPairDialogRevision']) {
      if (state[key] === undefined) state[key] = 0;
    }
  }

  getDevice(deviceId) {
    return this.state.devices.find((device) => device.id === deviceId);
  }

  isTargetBusy(deviceId) {
    return this.isDeviceConnecting(deviceId) || this.isDeviceBusy(deviceId);
  }

  clearMessage(elementId) {
    const element = this.getElement(elementId);
    element.hidden = true;
    element.textContent = '';
  }

  resetDevice() {
    this.state.deviceDialogRevision++;
    this.state.editingDeviceId = null;
    this.getElement('form').reset();
    this.getElement('formTitle').textContent = '添加设备';
    this.getElement('save').textContent = '保存设备';
    this.clearMessage('formMessage');
    this.clearMessage('pairMessage');
    for (const elementId of ['pairCode', 'pairPort', 'pairIp']) {
      this.getElement(elementId).value = '';
    }
  }

  openDevice(deviceId = null) {
    if (this.state.isLoading || !this.state.isLoaded) return false;
    if (deviceId && this.isTargetBusy(deviceId)) {
      this.notify('这台设备正在连接 ADB 或投屏中，请完成当前操作后再修改配置。', 'error');
      return false;
    }
    const device = deviceId ? this.getDevice(deviceId) : null;
    if (deviceId && !device) return false;
    this.resetDevice();
    const options = this.getElement('groupNames');
    options.replaceChildren();
    const names = this.state.groups.map((group) => group.name);
    for (const name of names.sort((left, right) => left.localeCompare(right, 'zh-CN'))) {
      const option = this.createElement('option');
      option.value = name;
      options.append(option);
    }
    if (device) {
      this.state.editingDeviceId = device.id;
      this.getElement('name').value = device.name;
      this.getElement('group').value = device.group_name;
      this.getElement('ip').value = device.ip;
      this.getElement('port').value = device.port;
      this.getElement('formTitle').textContent = '编辑设备';
      this.getElement('save').textContent = '保存修改';
      this.getElement('pairIp').value = device.ip;
    }
    this.dialog.showDialog('deviceDialog', 'name');
    return true;
  }

  closeDevice() {
    if (!this.state.isLoading) this.dialog.closeDialog('deviceDialog');
  }

  submitDevice() {
    return this.saveDevice(this.state.editingDeviceId, {
      name: this.getElement('name').value,
      group_name: this.getElement('group').value,
      ip: this.getElement('ip').value.trim(),
      port: Number(this.getElement('port').value),
    });
  }

  openTemp(deviceId) {
    if (this.state.isLoading || !this.state.isLoaded || this.isTargetBusy(deviceId)) return false;
    const device = this.getDevice(deviceId);
    if (!device) return false;
    this.state.tempDialogRevision++;
    this.state.editingTempDeviceId = device.id;
    this.getElement('tempDialogTitle').textContent = device.temp_ip ? '修改临时 IP' : '添加临时 IP';
    this.getElement('tempIp').value = device.temp_ip || '';
    this.getElement('tempSharedPort').value = String(device.port);
    this.clearMessage('tempMessage');
    this.dialog.showDialog('tempDialog', 'tempIp');
    return true;
  }

  closeTemp() {
    if (!this.state.isLoading) this.dialog.closeDialog('tempDialog');
  }

  resetTemp() {
    this.state.tempDialogRevision++;
    this.state.editingTempDeviceId = null;
  }

  async submitTemp() {
    const deviceId = this.state.editingTempDeviceId;
    if (!deviceId || this.state.isLoading || !this.state.isLoaded) return false;
    const generation = this.state.generation;
    const revision = this.state.tempDialogRevision;
    const saved = await this.saveTempAddress(
      deviceId,
      this.getElement('tempIp').value.trim(),
      Number(this.getElement('tempSharedPort').value),
    );
    if (
      saved &&
      generation === this.state.generation &&
      revision === this.state.tempDialogRevision &&
      deviceId === this.state.editingTempDeviceId
    ) {
      this.dialog.closeDialog('tempDialog');
      return true;
    }
    return false;
  }

  openFirstPair(deviceId) {
    if (this.state.isLoading || !this.state.isLoaded) return false;
    const device = this.getDevice(deviceId);
    if (!device || this.isTargetBusy(deviceId) || !device.connect_failed || !device.selected_serial)
      return false;
    this.resetFirstPair();
    this.state.pairingDeviceId = device.id;
    this.state.pairingSerial = device.selected_serial;
    this.getElement('firstPairTitle').textContent = '首次连接 · ' + device.name;
    this.getElement('firstPairIp').value = device.selected_serial.slice(
      0,
      device.selected_serial.lastIndexOf(':'),
    );
    this.dialog.showDialog('firstPairDialog', 'firstPairPort');
    return true;
  }

  closeFirstPair() {
    if (!this.state.isLoading) this.dialog.closeDialog('firstPairDialog');
  }

  resetFirstPair() {
    this.state.firstPairDialogRevision++;
    this.state.pairingDeviceId = null;
    this.state.pairingSerial = null;
    this.getElement('firstPairForm').reset();
    this.clearMessage('firstPairMessage');
  }

  canPair() {
    return this.state.isLoaded && !this.state.isLoading && !this.state.activePairOperation;
  }

  beginPair(kind) {
    const operation = {
      kind,
      generation: this.state.generation,
      revision:
        kind === 'device' ? this.state.firstPairDialogRevision : this.state.deviceDialogRevision,
      deviceId: kind === 'device' ? this.state.pairingDeviceId : this.state.editingDeviceId,
      serial: kind === 'device' ? this.state.pairingSerial : null,
      abortController: new AbortController(),
    };
    this.state.activePairOperation = operation;
    this.state.isLoading = true;
    return operation;
  }

  isCurrentPair(operation) {
    return (
      this.state.activePairOperation === operation && this.state.generation === operation.generation
    );
  }

  isCurrentPairDialog(operation) {
    if (!this.isCurrentPair(operation)) return false;
    if (operation.kind === 'address') {
      return (
        this.getElement('deviceDialog').open &&
        this.state.deviceDialogRevision === operation.revision &&
        this.state.editingDeviceId === operation.deviceId
      );
    }
    const device = this.getDevice(operation.deviceId);
    return Boolean(
      this.getElement('firstPairDialog').open &&
      this.state.firstPairDialogRevision === operation.revision &&
      this.state.pairingDeviceId === operation.deviceId &&
      this.state.pairingSerial === operation.serial &&
      device?.selected_serial === operation.serial &&
      !this.isTargetBusy(operation.deviceId),
    );
  }

  finishPair(operation) {
    if (!this.isCurrentPair(operation)) return;
    this.state.activePairOperation = null;
    this.state.isLoading = false;
    if (operation.kind === 'device') this.getElement('submitFirstPair').disabled = false;
    this.onChange();
  }

  invalidate() {
    const operation = this.state.activePairOperation;
    if (operation) {
      this.state.activePairOperation = null;
      operation.abortController.abort();
      this.state.isLoading = false;
      if (operation.kind === 'device') this.getElement('submitFirstPair').disabled = false;
    }
    this.state.deviceDialogRevision++;
    this.state.tempDialogRevision++;
    this.state.firstPairDialogRevision++;
  }

  async pairAddress() {
    if (!this.canPair() || !this.getElement('deviceDialog').open) return false;
    const payload = {
      ip: this.getElement('pairIp').value.trim() || this.getElement('ip').value.trim(),
      port: Number(this.getElement('pairPort').value),
      code: this.getElement('pairCode').value.trim(),
    };
    const operation = this.beginPair('address');
    try {
      this.onChange();
      this.notify('正在配对…');
      if (!this.isCurrentPairDialog(operation)) return false;
      const response = await this.request('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: operation.abortController.signal,
      });
      if (!this.isCurrentPairDialog(operation)) return false;
      const result = await response.json();
      if (!this.isCurrentPairDialog(operation)) return false;
      this.getElement('pairCode').value = '';
      this.dialog.modalMessage(result.message, 'ok', 'pairMessage');
      return true;
    } catch (error) {
      if (this.isCurrentPairDialog(operation)) {
        this.dialog.modalMessage(error.message, 'error', 'pairMessage');
      }
      return false;
    } finally {
      this.finishPair(operation);
    }
  }

  async pairDevice() {
    if (!this.canPair() || !this.getElement('firstPairDialog').open) return false;
    const deviceId = this.state.pairingDeviceId;
    const serial = this.state.pairingSerial;
    const device = this.getDevice(deviceId);
    if (!device || !serial || device.selected_serial !== serial || this.isTargetBusy(deviceId)) {
      this.dialog.modalMessage(
        '设备已移除、连接地址已变更或正在连接/投屏，请关闭后重新选择设备。',
        'error',
        'firstPairMessage',
      );
      return false;
    }
    const payload = {
      port: Number(this.getElement('firstPairPort').value),
      code: this.getElement('firstPairCode').value.trim(),
      selected_serial: serial,
    };
    const operation = this.beginPair('device');
    try {
      this.getElement('submitFirstPair').disabled = true;
      this.onChange();
      if (!this.isCurrentPairDialog(operation)) return false;
      const response = await this.request(
        '/api/devices/' + encodeURIComponent(deviceId) + '/pair',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: operation.abortController.signal,
        },
      );
      if (!this.isCurrentPairDialog(operation)) return false;
      const result = await response.json();
      if (!this.isCurrentPairDialog(operation)) return false;
      this.getElement('firstPairCode').value = '';
      this.dialog.modalMessage(
        result.message + '。请关闭弹窗，再手动点击「连接」；不会自动重试。',
        'ok',
        'firstPairMessage',
      );
      return true;
    } catch (error) {
      if (this.isCurrentPairDialog(operation)) {
        this.dialog.modalMessage(error.message, 'error', 'firstPairMessage');
      }
      return false;
    } finally {
      this.finishPair(operation);
    }
  }

  bindEvents() {
    if (this.hasBoundEvents) return;
    this.hasBoundEvents = true;
    const listen = (id, eventName, listener) =>
      this.getElement(id).addEventListener(eventName, listener);
    listen('newDevice', 'click', () => this.openDevice());
    for (const id of ['closeDialog', 'cancelDialog']) {
      listen(id, 'click', () => this.closeDevice());
    }
    for (const id of ['closeTempDialog', 'cancelTempDialog']) {
      listen(id, 'click', () => this.closeTemp());
    }
    for (const id of ['closeFirstPair', 'cancelFirstPair']) {
      listen(id, 'click', () => this.closeFirstPair());
    }
    for (const id of ['deviceDialog', 'tempDialog', 'firstPairDialog']) {
      listen(id, 'cancel', (event) => {
        if (this.state.isLoading) event.preventDefault();
      });
    }
    listen('deviceDialog', 'close', () => this.resetDevice());
    listen('tempDialog', 'close', () => this.resetTemp());
    listen('firstPairDialog', 'close', () => this.resetFirstPair());
    listen('deviceDialog', 'click', (event) => {
      if (event.target === this.getElement('deviceDialog')) this.closeDevice();
    });
    listen('firstPairDialog', 'click', (event) => {
      if (event.target === this.getElement('firstPairDialog')) this.closeFirstPair();
    });
    listen('form', 'submit', (event) => {
      event.preventDefault();
      return this.submitDevice();
    });
    listen('tempForm', 'submit', (event) => {
      event.preventDefault();
      return this.submitTemp();
    });
    listen('firstPairForm', 'submit', (event) => {
      event.preventDefault();
      return this.pairDevice();
    });
    listen('pair', 'click', () => this.pairAddress());
  }
}

export function createDeviceDialogController(options) {
  return new DeviceDialogController(options);
}
