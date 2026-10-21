// Pure display projection; never owns ADB/session state or mutates the input records.
export function hasConnectedAdb(device) {
  if (!device) return false;
  return (
    device.status === 'connected' &&
    device.connect_failed !== true &&
    Boolean(device.selected_serial) &&
    device.active_serial === device.selected_serial
  );
}

export function buildDeviceGroups(devices, groups) {
  const grouped = new Map();
  for (const group of groups) {
    grouped.set('named:' + group.name, {
      title: group.name,
      ip_prefix: group.ip_prefix,
      discovery_configured: group.discovery_configured,
      discovery_needs_password: group.discovery_needs_password,
      items: [],
    });
  }
  for (const device of devices) {
    const key = device.group_name ? 'named:' + device.group_name : 'ungrouped';
    if (!grouped.has(key)) {
      grouped.set(key, {
        title: device.group_name || '未分组',
        ip_prefix: null,
        items: [],
      });
    }
    grouped.get(key).items.push(device);
  }
  for (const group of grouped.values()) {
    group.items.sort((a, b) => Number(hasConnectedAdb(b)) - Number(hasConnectedAdb(a)));
  }
  const keys = [...grouped.keys()].sort((a, b) => {
    const aConnected = grouped.get(a).items.some(hasConnectedAdb);
    const bConnected = grouped.get(b).items.some(hasConnectedAdb);
    if (aConnected !== bConnected) return aConnected ? -1 : 1;
    if (a === b) return 0;
    if (a === 'ungrouped') return 1;
    if (b === 'ungrouped') return -1;
    return grouped.get(a).title.localeCompare(grouped.get(b).title, 'zh-CN');
  });
  return { grouped, keys };
}
