// Group dialogs share the page's state and request owners. Construction does
// not load devices, scan routers or replace work started before module bootstrap.
export class GroupDialogController {
  constructor({
    state,
    getElement,
    dialog,
    request,
    refreshDevices,
    isDeviceBusy,
    isDeviceConnecting,
    confirmDelete,
    onChange,
    notify,
    dismissToast,
    showScanResult,
    showScanError,
  }) {
    this.state = state;
    this.getElement = getElement;
    this.dialog = dialog;
    this.request = request;
    this.refreshDevices = refreshDevices;
    this.isDeviceBusy = isDeviceBusy;
    this.isDeviceConnecting = isDeviceConnecting;
    this.confirmDelete = confirmDelete;
    this.onChange = onChange;
    this.notify = notify;
    this.dismissToast = dismissToast;
    this.showScanResult = showScanResult;
    this.showScanError = showScanError;
    this.hasBoundEvents = false;
    if (state.activeOperation === undefined) state.activeOperation = null;
    if (state.dialogRevision === undefined) state.dialogRevision = 0;
    if (state.hasSavedDiscovery === undefined) {
      state.hasSavedDiscovery = Boolean(
        state.groups.find((group) => group.name === state.editingGroupName)?.discovery_configured,
      );
    }
    if (state.scanningGroupNames === undefined) state.scanningGroupNames = new Set();
    if (state.scanOperations === undefined) state.scanOperations = new Map();
  }

  bindEvents() {
    if (this.hasBoundEvents) return;
    this.hasBoundEvents = true;
    const bind = (id, type, callback) => this.getElement(id).addEventListener(type, callback);
    bind('newGroup', 'click', () => this.openGroup());
    bind('closeGroup', 'click', () => this.closeGroup());
    bind('cancelGroup', 'click', () => this.closeGroup());
    bind('groupDialog', 'cancel', (event) => {
      if (!this.canCloseGroup()) event.preventDefault();
    });
    bind('groupDialog', 'close', () => this.resetGroup());
    bind('groupDialog', 'click', (event) => {
      if (event.target === this.getElement('groupDialog')) this.closeGroup();
    });
    bind('groupForm', 'submit', (event) => {
      event.preventDefault();
      return this.saveGroup();
    });
    bind('deleteGroup', 'click', () => this.deleteGroup());
    bind('testGroupDiscovery', 'click', () => {
      if (this.state.editingGroupName) return this.scanGroup(this.state.editingGroupName, true);
    });
  }

  isGroupBusy(name) {
    return this.state.devices.some(
      (device) =>
        device.group_name === name &&
        (this.isDeviceConnecting(device.id) || this.isDeviceBusy(device.id)),
    );
  }

  openGroup(name = null) {
    const state = this.state;
    if (state.isLoading || !state.isLoaded) return false;
    const group = name ? state.groups.find((entry) => entry.name === name) : null;
    if (name && !group) return false;
    if (group && this.isGroupBusy(name)) {
      this.notify('该分组包含正在投屏的设备：可新建分组，但修改此分组请先停止相关设备。', 'error');
      return false;
    }
    state.dialogRevision++;
    state.editingGroupName = group ? group.name : null;
    state.hasSavedDiscovery = Boolean(group?.discovery_configured);
    this.getElement('groupForm').reset();
    this.getElement('groupMessage').hidden = true;
    this.getElement('groupMessage').textContent = '';
    this.getElement('groupFormTitle').textContent = group ? '编辑分组' : '添加分组';
    this.getElement('saveGroup').textContent = group ? '保存修改' : '保存分组';
    this.getElement('deleteGroup').hidden = !group;
    this.getElement('testGroupDiscovery').disabled = false;
    if (group) {
      this.getElement('groupName').value = group.name;
      this.getElement('groupPrefix').value = group.ip_prefix || '';
      this.getElement('groupOpenWrtUrl').value = group.discovery_url || '';
      this.getElement('groupOpenWrtUser').value = group.discovery_username || 'easyadb';
      this.getElement('groupDiscoveryPanel').open = Boolean(group.discovery_configured);
      this.getElement('testGroupDiscovery').hidden = !group.discovery_configured;
      if (group.discovery_needs_password) {
        this.modalMessage('旧版加密凭据不再使用，请重新粘贴 OpenWrt 专用密钥并保存。');
      }
    } else {
      this.getElement('groupOpenWrtUser').value = 'easyadb';
      this.getElement('groupDiscoveryPanel').open = false;
      this.getElement('testGroupDiscovery').hidden = true;
    }
    this.dialog.showDialog('groupDialog', 'groupName');
    return true;
  }

  canCloseGroup() {
    return !this.state.isLoading && !this.state.scanningGroupNames.has(this.state.editingGroupName);
  }

  closeGroup() {
    if (!this.canCloseGroup()) return false;
    this.dialog.closeDialog('groupDialog');
    return true;
  }

  resetGroup() {
    this.state.dialogRevision++;
    this.state.editingGroupName = null;
    this.state.hasSavedDiscovery = false;
  }

  modalMessage(text, kind = 'error') {
    this.dialog.modalMessage(text, kind, 'groupMessage');
  }

  canStartOperation() {
    return (
      this.state.isLoaded &&
      !this.state.isLoading &&
      !this.state.activeOperation &&
      !this.state.scanningGroupNames.has(this.state.editingGroupName) &&
      this.getElement('groupDialog').open
    );
  }

  beginOperation() {
    const operation = {
      generation: this.state.generation,
      abortController: new AbortController(),
      dialogRevision: this.state.dialogRevision,
      groupName: this.state.editingGroupName,
      isTest: false,
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

  isCurrentDialog(operation) {
    return (
      this.state.dialogRevision === operation.dialogRevision &&
      this.state.editingGroupName === operation.groupName &&
      this.getElement('groupDialog').open
    );
  }

  finishOperation(operation) {
    if (!this.isCurrentOperation(operation)) return;
    this.state.activeOperation = null;
    this.state.isLoading = false;
    this.onChange();
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

  async saveGroup() {
    const state = this.state;
    if (!this.canStartOperation()) return false;
    if (state.editingGroupName && this.isGroupBusy(state.editingGroupName)) {
      this.modalMessage('该分组包含正在投屏的设备，请先停止这些设备再修改；新建分组不受限制。');
      return false;
    }
    const form = this.getElement('groupForm');
    if (form.reportValidity && !form.reportValidity()) return false;
    // Snapshot both requests before rendering or awaiting. Changing form fields
    // while the first request is pending must not configure a different router.
    const payload = {
      name: this.getElement('groupName').value,
      ip_prefix: this.getElement('groupPrefix').value.trim() || null,
    };
    const routerUrl = this.getElement('groupOpenWrtUrl').value.trim();
    const routerUser = this.getElement('groupOpenWrtUser').value.trim() || 'easyadb';
    const routerPassword = this.getElement('groupOpenWrtPassword').value;
    const previousName = state.editingGroupName;
    const operation = this.beginOperation();
    try {
      this.onChange();
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      const path = previousName ? '/api/groups/' + encodeURIComponent(previousName) : '/api/groups';
      const response = await this.request(path, {
        method: previousName ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: operation.abortController.signal,
      });
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      const saved = await response.json();
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      if (!saved?.name) throw Error('分组保存响应缺少名称');
      // Persist this even if the discovery request fails. Metadata may still
      // contain the old name, so discovery ownership cannot be re-derived from it.
      state.editingGroupName = saved.name;
      operation.groupName = saved.name;
      if (previousName && previousName !== saved.name) {
        this.dismissToast('discovery:' + previousName);
      }
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      if (routerUrl) {
        await this.request('/api/groups/' + encodeURIComponent(saved.name) + '/discovery', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: routerUrl, username: routerUser, password: routerPassword }),
          signal: operation.abortController.signal,
        });
        if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
        state.hasSavedDiscovery = true;
      } else if (state.hasSavedDiscovery) {
        await this.request('/api/groups/' + encodeURIComponent(saved.name) + '/discovery', {
          method: 'DELETE',
          signal: operation.abortController.signal,
        });
        if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
        state.hasSavedDiscovery = false;
        this.dismissToast('discovery:' + saved.name);
      }
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      this.getElement('groupOpenWrtPassword').value = '';
      this.dialog.closeDialog('groupDialog');
      if (!this.isCurrentOperation(operation)) return false;
      this.notify('分组设置已保存', 'ok');
      await this.refreshAfterOperation(operation, '分组已保存，但列表刷新失败');
      return this.isCurrentOperation(operation);
    } catch (error) {
      if (this.isCurrentOperation(operation) && this.isCurrentDialog(operation)) {
        this.modalMessage(error.message);
      }
      return false;
    } finally {
      this.finishOperation(operation);
    }
  }

  async deleteGroup() {
    const state = this.state;
    if (!this.canStartOperation() || !state.editingGroupName) return false;
    const name = state.editingGroupName;
    const busyMessage = '该分组包含正在投屏的设备，请先停止这些设备，再删除分组。';
    if (this.isGroupBusy(name)) {
      this.modalMessage(busyMessage);
      return false;
    }
    const generation = state.generation;
    const dialogRevision = state.dialogRevision;
    const count = state.devices.filter((device) => device.group_name === name).length;
    const detail = count ? '列表中的 ' + count + ' 台设备会移入「未分组」。' : '这是一个空分组。';
    if (
      !this.confirmDelete(
        '确认删除分组「' +
          name +
          '」？\n' +
          detail +
          '\n设备记录和 ADB 授权会保留，原分组内网 IP 映射会取消。',
      )
    )
      return false;
    if (
      generation !== state.generation ||
      dialogRevision !== state.dialogRevision ||
      name !== state.editingGroupName ||
      !this.canStartOperation()
    )
      return false;
    if (this.isGroupBusy(name)) {
      this.modalMessage(busyMessage);
      return false;
    }
    const operation = this.beginOperation();
    try {
      this.onChange();
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      const response = await this.request('/api/groups/' + encodeURIComponent(name), {
        method: 'DELETE',
        signal: operation.abortController.signal,
      });
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      const result = await response.json();
      if (!this.isCurrentOperation(operation) || !this.isCurrentDialog(operation)) return false;
      this.dialog.closeDialog('groupDialog');
      if (!this.isCurrentOperation(operation)) return false;
      state.groupOpen.delete('named:' + name);
      this.dismissToast('discovery:' + name);
      this.notify('分组已删除，' + result.moved_count + ' 台设备已移入「未分组」', 'ok');
      await this.refreshAfterOperation(operation, '分组已删除，但列表刷新失败');
      if (!this.isCurrentOperation(operation)) return false;
      return true;
    } catch (error) {
      if (this.isCurrentOperation(operation) && this.isCurrentDialog(operation)) {
        this.modalMessage(error.message);
      }
      return false;
    } finally {
      this.finishOperation(operation);
    }
  }

  isCurrentScan(operation) {
    return (
      this.state.scanOperations.get(operation.groupName) === operation &&
      this.state.generation === operation.generation
    );
  }

  async scanGroup(name, isTest = false) {
    const state = this.state;
    if (
      !state.isLoaded ||
      state.isLoading ||
      state.scanningGroupNames.has(name) ||
      state.scanOperations.has(name) ||
      state.devices.some(
        (device) => device.group_name === name && this.isDeviceConnecting(device.id),
      )
    )
      return false;
    const operation = {
      generation: state.generation,
      abortController: new AbortController(),
      dialogRevision: state.dialogRevision,
      groupName: name,
      isTest,
    };
    if (isTest && !this.isCurrentDialog(operation)) return false;
    const options = { method: 'POST', signal: operation.abortController.signal };
    if (isTest) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({
        url: this.getElement('groupOpenWrtUrl').value.trim(),
        username: this.getElement('groupOpenWrtUser').value.trim() || 'easyadb',
        password: this.getElement('groupOpenWrtPassword').value,
      });
    }
    state.scanOperations.set(name, operation);
    state.scanningGroupNames.add(name);
    try {
      if (isTest) this.getElement('testGroupDiscovery').disabled = true;
      this.onChange();
      if (!this.isCurrentScan(operation)) return false;
      const response = await this.request(
        '/api/groups/' + encodeURIComponent(name) + '/discovery/' + (isTest ? 'test' : 'scan'),
        options,
      );
      if (!this.isCurrentScan(operation)) return false;
      const result = await response.json();
      if (!this.isCurrentScan(operation)) return false;
      if (isTest) {
        if (this.isCurrentDialog(operation)) {
          this.modalMessage(
            '鉴权及扫描权限正常，本次返回 ' + result.found + ' 条记录（不会更新设备端口）。',
            'ok',
          );
        }
      } else {
        // A completed discovery result remains useful even when the separate
        // metadata read fails. Keep its rich toast and report refresh separately.
        try {
          const refreshed = await this.refreshDevices();
          if (refreshed === false && this.isCurrentScan(operation)) {
            this.notify('扫描已完成，但列表刷新失败：请检查访问密钥或服务端连接', 'error');
          }
        } catch (error) {
          if (this.isCurrentScan(operation)) {
            this.notify('扫描已完成，但列表刷新失败：' + error.message, 'error');
          }
        }
        if (!this.isCurrentScan(operation)) return false;
        this.showScanResult(name, result);
      }
      return true;
    } catch (error) {
      if (this.isCurrentScan(operation)) {
        if (isTest) {
          if (this.isCurrentDialog(operation)) this.modalMessage(error.message);
        } else this.showScanError(name, error.message);
      }
      return false;
    } finally {
      if (this.isCurrentScan(operation)) {
        state.scanOperations.delete(name);
        state.scanningGroupNames.delete(name);
        if (isTest && this.isCurrentDialog(operation)) {
          this.getElement('testGroupDiscovery').disabled = false;
        }
        this.onChange();
      }
    }
  }

  invalidate() {
    const state = this.state;
    const operation = state.activeOperation;
    const scans = [...state.scanOperations.values()];
    if (operation) {
      state.activeOperation = null;
      state.isLoading = false;
    }
    for (const scan of scans) {
      if (state.scanOperations.get(scan.groupName) !== scan) continue;
      state.scanOperations.delete(scan.groupName);
      state.scanningGroupNames.delete(scan.groupName);
      if (scan.isTest && this.isCurrentDialog(scan)) {
        this.getElement('testGroupDiscovery').disabled = false;
      }
    }
    state.dialogRevision++;
    // Drop ownership before aborting: abort callbacks may start replacement work.
    operation?.abortController.abort();
    for (const scan of scans) scan.abortController.abort();
  }
}

export function createGroupDialogController(options) {
  return new GroupDialogController(options);
}
