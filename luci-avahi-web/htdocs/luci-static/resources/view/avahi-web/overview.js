'use strict';
'require view';
'require fs';
'require ui';

var HELPER = '/usr/libexec/luci-avahi-web';
var SCANNER = '/usr/libexec/luci-avahi-scan';
var AUTH = '/usr/libexec/luci-avahi-auth';

function command(program, args) {
	return fs.exec(program, args).then(function(result) {
		if (result.code !== 0)
			throw new Error((result.stderr || result.stdout || _('操作失败')).trim());
		return result.stdout || '';
	});
}
function control(action, args) { return command(HELPER, [ action ].concat(args || [])); }
function snapshot() { return command(SCANNER, [ 'last' ]); }
function auth(action) { return command(AUTH, [ action ]); }
function values(output) {
	var obj = {};
	String(output || '').split('\n').forEach(function(line) {
		var i = line.indexOf('=');
		if (i > 0) obj[line.slice(0, i)] = line.slice(i + 1);
	});
	return obj;
}
function inventory(output) {
	var result = {};
	String(output || '').split('\n').forEach(function(line) {
		var fields = line.split('\t');
		if (fields.length === 3 && /^[a-z0-9-]+$/.test(fields[0]))
			result[fields[0]] = { installed: fields[1] === 'installed', version: fields[2] };
	});
	return result;
}
function cell(value) { return E('td', [ value == null || value === '' ? '-' : String(value) ]); }

return view.extend({
	load: function() {
		return Promise.all([
			control('status'),
			control('package', [ 'list' ]),
			snapshot().catch(function() { return ''; }),
			auth('status').catch(function() { return 'state=error'; })
		]);
	},
	render: function(data) {
		var componentsNode = E('div'), summaryNode = E('div');
		var lastNode = E('div'), noticeNode = E('div');
		var authStateNode = E('div'), authCredentialNode = E('div');
		var operationOutput = E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto' });
		var operationDetails = E('details', { style: 'margin-top:12px;' }, [
			E('summary', { style: 'cursor:pointer;' }, [ '查看最近一次软件包操作输出' ]), operationOutput
		]);
		var busy = false, runtimeBusy = false, refreshing = false;
		var manualButton;
		var currentStatus = {}, currentPackages = {};
		var groups = [
			{ id: 'avahi', label: 'Avahi', note: '用于发现 Android 无线调试动态端口', process: 'running', init: 'avahi-daemon', bins: [ ['avahi-daemon-bin','avahi-daemon'], ['avahi-browse-bin','avahi-browse'] ], start: 'start', stop: 'stop', enable: 'enable', disable: 'disable', packages: [ 'avahi-dbus-daemon', 'avahi-utils' ] },
			{ id: 'dbus', label: 'D-Bus', note: 'Avahi 的进程间通信依赖', process: 'dbus', init: 'dbus', bins: [ ['dbus-bin','dbus-daemon'] ], start: 'dbus-start', packages: [ 'dbus' ] },
			{ id: 'umdns', label: 'umdns', note: 'OpenWrt 自带的 mDNS 服务', process: 'umdns', init: 'umdns', bins: [ ['umdns-bin','umdns'] ], start: 'umdns-start', stop: 'umdns-stop', enable: 'umdns-enable', disable: 'umdns-disable', packages: [ 'umdns' ] }
		];
		function alert(text, error) {
			noticeNode.replaceChildren(text ? E('p', {
				'class': error ? 'alert-message warning' : 'alert-message notice'
			}, [ text ]) : '');
		}

		function statusMark(label, kind) {
			var colors = {
				ok: { background: '#e3f4e9', color: '#126a39', border: '#9dd7b1' },
				warn: { background: '#fff3d6', color: '#855600', border: '#e4c477' },
				bad: { background: '#fce8e6', color: '#ad3029', border: '#e4a5a0' },
				idle: { background: '#e9ecef', color: '#4e5863', border: '#c7cdd1' }
			};
			var c = colors[kind] || colors.idle;
			return E('span', { style: 'display:inline-block;margin:3px 6px 3px 0;padding:3px 9px;border-radius:5px;font-weight:600;border:1px solid ' +
				c.border + ';background:' + c.background + ';color:' + c.color + ';' }, [ label ]);
		}
		function packageState(group) {
			var known = group.packages.every(function(pkg) { return !!currentPackages[pkg]; });
			if (!known) return { state: 'unknown', missing: group.packages };
			var missing = group.packages.filter(function(pkg) { return !currentPackages[pkg].installed; });
			return { state: missing.length === 0 ? 'complete' :
				missing.length === group.packages.length ? 'absent' : 'partial', missing: missing };
		}
		function serviceButton(label, group, action, disabled, kind) {
			return E('button', {
				type: 'button',
				'class': 'cbi-button ' + (kind === 'danger' ? 'cbi-button-negative' :
					kind === 'positive' ? 'cbi-button-positive' : 'cbi-button-neutral'),
				disabled: disabled || runtimeBusy || busy || refreshing,
				click: function() {
					if (disabled || runtimeBusy || busy || refreshing) return;
					var perform = function() {
						runtimeBusy = true;
						drawComponents();
						return control('service', [ action ]).then(function() {
							alert(group.label + '：操作已完成。');
						}).catch(function(e) {
							alert(group.label + '：' + e.message, true);
						}).then(refreshStatus).then(function() {
							runtimeBusy = false; drawComponents();
						}, function(e) {
							runtimeBusy = false; drawComponents(); alert(e.message, true);
						});
					};
					if ([ 'stop', 'umdns-stop', 'umdns-disable' ].indexOf(action) < 0)
						return perform();
					ui.showModal('确认服务操作', [
						E('p', [ '停止或禁用 ' + group.label + ' 可能影响局域网内其他设备的发现。' ]),
						E('p', [ '即将执行：' + label ]),
						E('div', { 'class': 'right' }, [
							E('button', { 'class': 'btn', click: ui.hideModal }, [ '取消' ]), ' ',
							E('button', { 'class': 'btn cbi-button-apply', click: function() {
								ui.hideModal();
								return perform();
							} }, [ '确认操作' ])
						])
					]);
				}
			}, [ label ]);
		}
		function pkgButton(label, group, action, disabled) {
			return E('button', {
				type: 'button',
				'class': 'cbi-button ' + (action === 'install' ? 'cbi-button-positive' :
					action === 'remove' ? 'cbi-button-negative' : 'cbi-button-action'),
				disabled: disabled || runtimeBusy || busy || refreshing,
				click: function() {
					if (disabled || runtimeBusy || busy || refreshing) return;
					return preview(action, group.id);
				}
			}, [ label ]);
		}
		function drawComponents() {
			if (manualButton) manualButton.disabled = busy || runtimeBusy || refreshing;
			var s = currentStatus, conflict = s.running === 'yes' && s.umdns === 'yes';
			var cards = groups.map(function(group) {
				var pkg = packageState(group), running = s[group.process] === 'yes';
				var init = s[group.init + '-init'] === 'yes';
				var enabled = s[group.init + '-enabled'] === 'yes';
				var missingBins = group.bins.filter(function(bin) { return s[bin[0]] !== 'yes'; })
					.map(function(bin) { return bin[1]; });
				var ready = pkg.state === 'complete' && missingBins.length === 0 && init;
				var otherRunning = group.id === 'avahi' ? s.umdns === 'yes' :
					group.id === 'umdns' ? s.running === 'yes' : false;
				var installLabel = pkg.state === 'complete' ?
					(ready ? '安装完整' : '运行条件不完整') :
					pkg.state === 'partial' ? '部分安装' :
					pkg.state === 'absent' ? '未安装' : '状态未知';
				var installedCount = group.packages.length - pkg.missing.length;
				var packageRows = group.packages.map(function(name) {
					var p = currentPackages[name], ok = !!p && p.installed;
					return E('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border-color-low, #eee);flex-wrap:wrap;' }, [
						E('code', [ name ]),
						E('span', [ ok ? p.version || '已安装' : '未安装' ])
					]);
				});
				var actions = [
					serviceButton('启动', group, group.start, !ready || running || otherRunning, 'positive')
				];
				if (group.stop) actions.push(serviceButton('停止', group, group.stop, !running, 'danger'));
				if (group.enable) actions.push(serviceButton('启用自启', group, group.enable, !ready || enabled, 'positive'));
				if (group.disable) actions.push(serviceButton('关闭自启', group, group.disable, !init || !enabled, 'neutral'));
				var missing = [];
				if (pkg.state !== 'unknown' && pkg.missing.length)
					missing.push(E('p', { style: 'margin:6px 0;color:#976000;' }, [ '缺少软件包：' + pkg.missing.join('、') ]));
				if (pkg.state === 'complete' && missingBins.length)
					missing.push(E('p', { style: 'margin:6px 0;color:#976000;' }, [ '缺少运行文件：' + missingBins.join('、') ]));
				if (pkg.state === 'complete' && !init)
					missing.push(E('p', { style: 'margin:6px 0;color:#976000;' }, [ '缺少服务启动脚本：' + group.init ]));
				if (otherRunning && group.stop)
					missing.push(E('p', { style: 'margin:6px 0;color:#976000;' }, [ '启动、安装或更新该 mDNS 组件前，请先停止另一项 mDNS 服务。' ]));
				if (group.id === 'dbus' && running)
					missing.push(E('p', { style: 'margin:6px 0;opacity:.8;' }, [ 'D-Bus 正在运行，为保护依赖它的进程，禁止直接卸载。' ]));
				return E('div', { 'class': 'cbi-section', style: 'min-width:0;margin:0;padding:15px;border:1px solid var(--border-color-medium, #d5d9dc);border-radius:8px;' }, [
					E('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:start;flex-wrap:wrap;' }, [
						E('div', [
							E('h3', { style: 'margin:0 0 4px;' }, [ group.label ]),
							E('p', { style: 'margin:0 0 8px;opacity:.78;' }, [ group.note ])
						]),
						statusMark(installLabel, ready ? 'ok' : pkg.state === 'absent' ? 'bad' : pkg.state === 'unknown' ? 'idle' : 'warn')
					]),
					E('div', { style: 'margin:5px 0 12px;' }, [
						statusMark(running ? '● 运行中' : '○ 已停止', running ? 'ok' : 'idle'),
						statusMark(!init ? '启动脚本缺失' : enabled ? '已启用自启' : '未启用自启',
							!init ? 'bad' : enabled ? 'ok' : 'idle')
					]),
					E('div', { style: 'margin-bottom:10px;' }, [
						E('strong', [ '服务控制' ]),
						E('div', { style: 'display:flex;gap:7px;flex-wrap:wrap;margin-top:7px;' }, actions)
					]),
					E('div', { style: 'padding-top:10px;border-top:1px solid var(--border-color-medium, #ddd);' }, [
						E('div', { style: 'display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;' }, [
							E('strong', [ '软件包' ]),
							E('span', [ '已安装 ' + installedCount + ' / ' + group.packages.length ])
						]),
						E('div', { style: 'font-size:.93em;margin:5px 0 8px;' }, packageRows),
						E('div', missing),
						E('div', { style: 'display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;' }, [
							pkgButton(pkg.state === 'partial' ? '补齐安装' : '安装',
								group, 'install', pkg.state === 'complete' || pkg.state === 'unknown' || otherRunning), 
							pkgButton('更新', group, 'upgrade', pkg.state !== 'complete' || otherRunning),
							pkgButton('卸载', group, 'remove', pkg.state === 'absent' || pkg.state === 'unknown' || running)
						])
					])
				]);
			});
			var installedGroups = groups.filter(function(g) { return packageState(g).state === 'complete'; }).length;
			var runningGroups = groups.filter(function(g) { return s[g.process] === 'yes'; }).length;
			summaryNode.replaceChildren(
				E('span', [ '组件完整：' + installedGroups + ' / 3　·　运行中：' + runningGroups + ' / 3' ])
			);
			componentsNode.replaceChildren(
				conflict ? E('div', { 'class': 'alert-message warning', style: 'margin-bottom:12px;' },
					[ 'Avahi 与 umdns 都检测到运行进程，可能存在 mDNS 5353 端口竞争。请按需选择保留哪一项；不会自动停止服务。' ]) : '',
				E('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px;' }, cards)
			);
		}
		function refreshStatus() {
			if (refreshing) return Promise.resolve();
			refreshing = true;
			drawComponents();
			return Promise.all([ control('status'), control('package', [ 'list' ]) ]).then(function(data) {
				currentStatus = values(data[0]);
				currentPackages = inventory(data[1]);
			}).catch(function(e) {
				alert('状态刷新失败：' + e.message, true);
			}).then(function() {
				refreshing = false;
				drawComponents();
			});
		}
		function manualRefresh() {
			if (busy || runtimeBusy || refreshing) return Promise.resolve();
			return refreshStatus();
		}
		function setBusy(on) {
			busy = on;
			drawComponents();
		}
		function execute(operation, group) {
			setBusy(true);
			operationDetails.open = true;
			operationOutput.textContent = _('正在执行软件包操作……');
			return control('package', [ 'apply', operation, group ]).then(function(result) {
				operationOutput.textContent = result;
				alert(_('软件包操作已完成，请查看下方输出。'));
			}).catch(function(e) {
				operationOutput.textContent = e.message;
				alert(_('软件包操作失败；未执行强制安装或卸载。'), true);
			}).then(function() {
				return refreshStatus();
			}).then(function() { setBusy(false); }, function(e) {
				setBusy(false); alert(e.message, true);
			});
		}
		function preview(operation, group) {
			if (busy || runtimeBusy || refreshing) return;
			setBusy(true);
			operationDetails.open = true;
			operationOutput.textContent = _('正在模拟并检查软件包依赖变更……');
			return control('package', [ 'plan', operation, group ]).then(function(result) {
				operationOutput.textContent = result;
				ui.showModal(_('确认软件包操作'), [
					E('p', [ _('SNAPSHOT 软件源可能已经变化，请核对模拟操作中的全部依赖变更；不会执行系统整体升级。') ]),
					E('p', [ _('目标：') + group + ' / ' + operation ]),
					E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto' },
						[ result || _('模拟结果未提出变更') ]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', click: function() { ui.hideModal(); setBusy(false); } }, [ _('取消') ]), ' ',
						E('button', { 'class': 'btn cbi-button-apply', click: function() {
							ui.hideModal();
							return execute(operation, group);
						} }, [ _('确认执行') ])
					])
				]);
			}).catch(function(e) {
				operationOutput.textContent = e.message;
				alert(_('软件包模拟操作失败，未修改任何已安装软件。'), true);
				setBusy(false);
			});
		}
		function refreshIndex() {
			if (busy || runtimeBusy || refreshing) return;
			ui.showModal(_('更新 APK 软件源索引'), [
				E('p', [ _('仅刷新软件源索引，不升级已安装的软件包。') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ _('取消') ]), ' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						ui.hideModal();
						setBusy(true);
						operationDetails.open = true;
						return control('package', [ 'refresh' ]).then(function(out) {
							operationOutput.textContent = out;
						}).catch(function(e) {
							operationOutput.textContent = e.message;
							alert(e.message, true);
						}).then(refreshStatus).then(function() { setBusy(false); },
							function(e) { setBusy(false); alert(e.message, true); });
					} }, [ _('确认执行') ])
				])
			]);
		}
		function renderAuth(output) {
			var current = values(output);
			var state = current.state || 'error';
			var text = state === 'managed'
				? _('已授权：easyadb（仅允许发起一次扫描）')
				: state === 'absent'
				? _('未创建')
				: state === 'conflict'
				? _('账号冲突：系统已有相同名称的 RPCD 账户或配置段，组件不会覆盖。')
				: _('无法读取账号授权状态。');
			authStateNode.replaceChildren(
				E('p', [ _('当前状态：') + text ]),
				E('p', [ _('授权角色：') + 'luci-avahi-easyadb' ]),
				E('div', [
					authButton(_('创建专用账号'), 'create', state !== 'absent'), ' ',
					authButton(_('重新生成凭据'), 'rotate', state !== 'managed'), ' ',
					authButton(_('撤销授权'), 'revoke', state !== 'managed')
				])
			);
		}
		function refreshAuth() {
			return auth('status').then(renderAuth).catch(function(e) {
				renderAuth('state=error');
				alert(e.message, true);
			});
		}
		function authButton(label, action, disabled) {
			return E('button', { type: 'button',
				'class': action === 'revoke' ? 'cbi-button cbi-button-negative' : 'cbi-button',
				disabled: disabled,
				click: function() { return confirmAuth(action); }
			}, [ label ]);
		}
		function applyAuth(action) {
			authCredentialNode.replaceChildren();
			return auth(action).then(function(out) {
				var info = values(out);
				if (action !== 'revoke') {
					if (!/^[0-9a-f]{64}$/.test(info.password || ''))
						throw new Error(_('账号已操作，但没有收到有效的一次性凭据，请检查 RPCD 状态。'));
					authCredentialNode.replaceChildren(
						E('p', { 'class': 'alert-message warning' }, [
							_('请立即复制并妥善保存密码！页面刷新后无法再次查看。')
						]),
						E('p', [ _('NAS 专用用户名：'), E('strong', [ info.username || 'easyadb' ]) ]),
						E('textarea', { readonly: '', rows: 2, 'class': 'cbi-input-textarea',
							style: 'max-width:100%;width:560px', value: info.password }),
						E('p', [ _('RPCD 即将重新加载。请在 EasyADB 中配置此凭据，不要使用路由器管理员密码。') ])
					);
				}
				else
					alert(_('NAS 专用授权已撤销，RPCD 会话将重新加载。'), false);
				return refreshAuth();
			}).catch(function(e) {
				alert(_('授权操作：') + e.message, true);
				return refreshAuth();
			});
		}
		function confirmAuth(action) {
			var warning = action === 'create'
				? _('创建名为 easyadb 的最小权限 RPCD 账户，随机密码仅显示一次。')
				: action === 'rotate'
				? _('将生成新的随机密码，必须同步更新 EasyADB 配置；重新加载 RPCD 后，旧密码不能用于再次登录。')
				: _('仅撤销本组件管理的 easyadb 专用账号，RPCD 重新加载后不再授权新的 NAS 扫描请求。');
			ui.showModal(_('确认 NAS 授权操作'), [
				E('p', [ warning ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ _('取消') ]), ' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						ui.hideModal();
						return applyAuth(action);
					} }, [ _('确认执行') ])
				])
			]);
		}
		function renderLast(output) {
			if (!output) {
				lastNode.replaceChildren(E('p', [ _('暂无 NAS 成功触发的扫描结果。') ]));
				return;
			}
			var result;
			try { result = JSON.parse(output); }
			catch (e) {
				lastNode.replaceChildren(E('p', { 'class': 'alert-message warning' }, [ _('最近一次扫描快照格式无效。') ]));
				return;
			}
			var records = Array.isArray(result.devices) ? result.devices : [];
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', [ _('服务实例') ]), E('th', [ _('网络接口') ]),
					E('th', [ _('IP 地址') ]), E('th', [ _('端口') ])
				])
			]);
			records.forEach(function(d) {
				table.appendChild(E('tr', { 'class': 'tr' }, [
					cell(d.instance), cell(d.iface), cell(d.address), cell(d.port)
				]));
			});
			lastNode.replaceChildren(
				E('p', [ _('最近成功扫描：') + (result.scanned_at ?
					new Date(result.scanned_at * 1000).toLocaleString() : '-') + ' | ' +
					_('发现端点：') + String(records.length) ]),
				records.length ? table : E('p', [ _('本次未发现已发布的 ADB TLS 服务。') ])
			);
		}
		function reloadLast() {
			return snapshot().then(renderLast).catch(function() { renderLast(''); });
		}
		manualButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: manualRefresh },
			[ '手动刷新组件状态' ]);
		currentPackages = inventory(data[1]);
		currentStatus = values(data[0]);
		drawComponents();
		renderLast(data[2]);
		renderAuth(data[3]);
		return E('div', [
			E('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;' }, [
				E('div', [
					E('h2', { style: 'margin:0 0 5px;' }, [ 'Avahi / EasyADB 发现代理' ]),
					E('p', { style: 'margin:0;opacity:.8;' }, [ '由 NAS 发起经过鉴权的按需扫描，路由器只保存最近一次结果。' ])
				]),
				manualButton
			]),
			noticeNode,
			E('div', { 'class': 'cbi-section', style: 'margin-bottom:14px;' }, [
				E('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:12px;' }, [
					E('div', [ E('h3', { style: 'margin:0 0 4px;' }, [ '组件与服务管理' ]),
						E('small', [ '页面首次加载与手动操作后才检测状态，不在后台轮询。' ]) ]),
					summaryNode
				]),
				componentsNode,
				E('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap;' }, [
					E('button', { type: 'button', 'class': 'cbi-button', click: refreshIndex },
						[ '刷新 APK 软件源索引' ])
				]),
				operationDetails
			]),
			E('div', { 'class': 'cbi-section', style: 'margin-bottom:14px;' }, [
				E('h3', [ 'NAS 接口授权' ]),
				E('p', [ '独立的 easyadb 账号仅允许执行一次 scan；创建或轮换后请立即保存只展示一次的凭据。' ]),
				authStateNode, authCredentialNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;' }, [
					E('div', [ E('h3', [ '最近一次 NAS 扫描' ]),
						E('p', [ '仅读取 /tmp 中的最近一次成功扫描快照，不触发新扫描；设备长期记录由 NAS 保存。' ]) ]),
					E('button', { type: 'button', 'class': 'cbi-button', click: reloadLast }, [ '刷新结果' ])
				]),
				lastNode
			])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
