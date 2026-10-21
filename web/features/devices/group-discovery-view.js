// Discovery result presentation only; scanning and saved-device updates belong
// to the dialog controller and its injected application ports.
export function renderDiscoveryResult(result, { elem }) {
  const panel = elem('div', 'group-discovery-status' + (result.error ? ' error' : ''));
  if (result.error) {
    panel.textContent = result.error;
    return panel;
  }
  const conflicts =
    (result.ambiguous || []).length +
    (result.conflicting || []).length +
    (result.route_conflict || []).length;
  panel.append(
    elem(
      'div',
      'discovery-head',
      '本次发现：' +
        result.found +
        ' 个 IP · 更新端口 ' +
        (result.updated || []).length +
        ' 台 · 未匹配 ' +
        (result.unmatched || []).length +
        ' · 忙碌跳过 ' +
        (result.busy || []).length +
        ' · 冲突 ' +
        conflicts,
    ),
  );
  if (!Array.isArray(result.endpoints)) {
    panel.append(elem('div', 'muted', '历史扫描尚无 IP:端口明细，点击「立即发现 ADB」可获取。'));
    return panel;
  }
  if (!result.endpoints.length) {
    panel.append(elem('div', 'muted', '未发现有效 ADB 端点。'));
    return panel;
  }
  panel.append(
    elem(
      'div',
      'discovery-legend',
      '绿色：已匹配并更新/端口不变 · 红色：未匹配本组设备 · 黄色：匹配异常或暂未更新',
    ),
  );
  const rows = elem('div', 'discovery-endpoints');
  const labels = {
    updated: '已匹配 · 端口已更新',
    unchanged: '已匹配 · 端口不变',
    unmatched: '未匹配本组设备',
    busy: '设备忙碌 · 未更新',
    ambiguous: 'IP 对应多台设备 · 未更新',
    conflicting: '同 IP 多端口 · 未更新',
    route_conflict: '连接地址冲突 · 未更新',
  };
  for (const endpoint of result.endpoints) {
    const tone =
      endpoint.status === 'updated' || endpoint.status === 'unchanged'
        ? 'matched'
        : endpoint.status === 'unmatched'
          ? 'unmatched'
          : 'skipped';
    const row = elem('div', 'discovery-endpoint ' + tone);
    row.append(elem('span', 'discovery-serial', endpoint.ip + ':' + endpoint.port));
    if (endpoint.device_name) row.append(elem('span', '', endpoint.device_name));
    row.append(elem('span', 'discovery-label', labels[endpoint.status] || '未更新'));
    rows.append(row);
  }
  panel.append(rows);
  return panel;
}
