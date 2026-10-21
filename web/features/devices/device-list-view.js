// Device management view only. Page/controller owns selection, ADB, CRUD and live sessions.
// Callbacks are injected so rendering never issues network requests or owns business state.
export function renderDeviceGroups({ list, grouped, keys, state, ui, on, elem, action }) {
  const {
    selectedId,
    selectedDeviceIds,
    isLoading,
    isLoaded,
    groupOpen,
    scanningGroups,
    isDeviceConnecting,
    isDeviceLocked,
    hasConnectedAdb,
  } = state;
  const {
    onSelectionChange,
    switchRoute,
    editDevice,
    removeTempAddress,
    openFirstPair,
    openTempEditor,
    openGroup,
    scanGroup,
  } = on;

  for (const key of keys) {
    const group = grouped.get(key);
    const section = elem('details', 'device-group');
    const shell = elem('div', 'group-shell');
    section.open = groupOpen.has(key) ? groupOpen.get(key) : true;
    section.addEventListener('toggle', () => groupOpen.set(key, section.open));
    const summary = elem('summary');
    summary.append(elem('span', '', group.title));
    if (group.ip_prefix) summary.append(elem('span', 'group-prefix', group.ip_prefix));
    summary.append(
      elem(
        'span',
        'group-count',
        group.items.filter(hasConnectedAdb).length + ' / ' + group.items.length + ' 已连接',
      ),
    );
    section.append(summary);
    const wrapper = elem('div', 'group-items');

    for (const device of group.items) {
      const item = elem('div', 'item' + (device.id === selectedId ? ' active' : ''));
      const top = elem('div', 'item-top');
      const info = elem('div', 'item-info');
      const managementLabel = elem('label', 'management-check');
      const managementCheck = elem('input');
      managementCheck.type = 'checkbox';
      managementCheck.value = device.id;
      managementCheck.checked = selectedDeviceIds.has(device.id);
      managementCheck.disabled = isLoading || isDeviceConnecting(device.id);
      managementCheck.setAttribute('aria-label', '批量选择 ' + device.name);
      managementCheck.addEventListener('change', () => {
        onSelectionChange(device.id, managementCheck.checked);
      });
      managementLabel.append(managementCheck, elem('span', '', '选择'));
      const primary = elem('div', 'device-primary');
      const addressRows = [];
      const title = elem('div', 'device-title');
      const name = elem('span', 'item-name', device.name);
      if (device.model || device.android_version) {
        name.tabIndex = 0;
        const descriptions = [];
        const model = elem('span', 'device-model-tooltip');
        if (device.model) {
          descriptions.push('设备型号 ' + device.model);
          model.append(elem('span', 'device-tooltip-line', '型号：' + device.model));
        }
        if (device.android_version) {
          descriptions.push('Android ' + device.android_version);
          model.append(elem('span', 'device-tooltip-line', 'Android：' + device.android_version));
        }
        name.setAttribute('aria-label', device.name + '，' + descriptions.join('，'));
        model.setAttribute('role', 'tooltip');
        name.append(model);
      }
      title.append(name);
      // ADB status and projection-state colors remain independent.
      const portWrap = elem('span', 'device-port-wrap');
      portWrap.append(
        ui.hasProjection
          ? ui.projectionButton(device)
          : elem('span', 'device-port', 'ADB ' + device.port),
      );
      if (ui.hasProjection) {
        const configure = action(
          '✎',
          () => ui.openProjectionSettings(device),
          'projection-settings-edit',
        );
        configure.title = '设置 ' + device.name + ' 的投屏参数与播放选项';
        configure.setAttribute('aria-label', configure.title);
        configure.disabled = isLoading || isDeviceConnecting(device.id);
        portWrap.append(configure);
      }
      title.append(portWrap);
      info.append(title);

      const addAddress = (label, route, ip, port = device.port) => {
        const chosen = device.selected_route === route;
        const row = elem(
          'div',
          'address-row' + (route === 'temp' ? ' has-remove' : route === 'mesh' ? ' has-edit' : ''),
        );
        const target = action(label + '：' + ip, () => switchRoute(device.id, route), 'address-target');
        target.disabled = isDeviceLocked(device.id);
        target.setAttribute('aria-pressed', String(chosen));
        target.setAttribute('aria-label', '选择' + device.name + '的' + label + ' ' + ip + ':' + port);
        target.title = chosen
          ? '点击对此 IP 主动连接一次'
          : '选择此 IP 并主动连接一次（不自动回退）';
        row.append(target);
        if (route === 'mesh') {
          const change = action('✎', () => editDevice(device.id), 'device-edit-icon');
          change.type = 'button';
          change.title = '编辑 ' + device.name;
          change.setAttribute('aria-label', '编辑设备 ' + device.name);
          change.disabled = isDeviceLocked(device.id);
          row.append(change);
        }
        if (route === 'temp') {
          const del = action('×', () => removeTempAddress(device.id), 'address-remove');
          del.type = 'button';
          del.title = '移除此设备临时 IP（不改变共用端口）';
          del.setAttribute('aria-label', '移除' + device.name + '的临时 IP');
          del.disabled = isDeviceLocked(device.id);
          row.append(del);
        }
        if (chosen && device.connect_failed) {
          const pairButton = action(
            '首次连接',
            () => openFirstPair(device.id),
            'first-pair',
          );
          pairButton.disabled = isLoading || isDeviceConnecting(device.id);
          pairButton.setAttribute('aria-label', '为' + device.name + '当前选择的' + label + '进行首次无线配对');
          row.append(pairButton);
        }
        addressRows.push(row);
      };
      addAddress('组网 IP', 'mesh', device.mesh_ip || device.ip);
      if (device.lan_ip) addAddress('内网 IP', 'lan', device.lan_ip);
      if (device.temp_ip) addAddress('临时 IP', 'temp', device.temp_ip);
      const addressList = elem('div', 'device-addresses');
      addressList.append(...addressRows);
      const plus = action('＋', () => openTempEditor(device), 'address-add');
      plus.title = device.temp_ip ? '修改临时 IP 与共用端口' : '添加临时 IP';
      plus.setAttribute('aria-label', plus.title);
      plus.disabled = isDeviceLocked(device.id);
      addressList.append(plus);
      top.append(managementLabel, info);
      primary.append(top, addressList);
      if (isDeviceConnecting(device.id)) {
        primary.append(elem('div', 'muted connection-pending', '此设备正在连接 ADB，其他设备可继续操作…'));
      } else if (device.last_error && device.status !== 'connected') {
        primary.append(elem('div', 'muted connection-error', device.last_error));
      }
      const actions = elem('div', 'item-actions');
      const labButton = action('电脑模式实验', () => ui.openDisplayLab(device.id), 'secondary');
      actions.append(labButton);
      labButton.disabled = isLoading || !isLoaded || isDeviceConnecting(device.id);
      primary.append(actions);
      item.append(primary);
      wrapper.append(item);
    }

    if (!group.items.length) wrapper.append(elem('p', 'hint', '该分组还没有设备。'));
    section.append(wrapper);
    shell.append(section);
    if (key !== 'ungrouped') {
      const tools = elem('div', 'group-tools');
      if (group.discovery_needs_password) {
        const renew = action(
          '重新填写专用密钥',
          () => openGroup(group.title),
          'secondary group-discovery',
        );
        renew.disabled =
          isLoading ||
          scanningGroups.has(group.title) ||
          group.items.some((device) => isDeviceConnecting(device.id));
        tools.append(renew);
        summary.style.paddingRight = '270px';
      } else if (group.discovery_configured) {
        const discover = action(
          scanningGroups.has(group.title) ? '正在发现…' : '立即发现 ADB',
          () => scanGroup(group.title),
          'secondary group-discovery',
        );
        discover.disabled =
          isLoading ||
          scanningGroups.has(group.title) ||
          group.items.some((device) => isDeviceConnecting(device.id));
        tools.append(discover);
        summary.style.paddingRight = '270px';
      }
      const config = action('设置', () => openGroup(group.title), 'secondary group-edit');
      config.disabled =
        isLoading ||
        scanningGroups.has(group.title) ||
        group.items.some((device) => isDeviceLocked(device.id));
      tools.append(config);
      shell.append(tools);
    }
    list.append(shell);
  }
}
