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
function scan() { return command(SCANNER, [ 'scan' ]); }
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
			result[fields[0]] = { installed: fields[1] === 'installed',
				version: /^[0-9A-Za-z][0-9A-Za-z._+~:-]{0,79}$/.test(fields[2]) ?
					fields[2] : '-' };
	});
	return result;
}
var VIEW_STYLE = ".avahi-web-root .avahi-panel {margin:0 0 12px;padding:16px 18px;background:var(--background-color-high,#fff);border:1px solid rgba(130,145,160,.18);border-radius:11px;box-shadow:0 2px 10px rgba(25,40,60,.035)}\n.avahi-web-root .avahi-panel h3 {margin:0;font-size:1.08em;line-height:1.4}\n.avahi-web-root .avahi-service-grid {display:grid !important;grid-template-columns:repeat(2,minmax(0,1fr)) !important;gap:12px;align-items:stretch;min-width:0}\n.avahi-web-root .avahi-component-card {box-sizing:border-box;min-width:0;margin:0 !important;padding:13px 15px;border:1px solid rgba(130,145,160,.22);border-radius:9px;background:var(--background-color-high,#fff);box-shadow:0 1px 4px rgba(30,40,65,.025)}\n.avahi-web-root .avahi-action-row {display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:7px}\n.avahi-web-root button.avahi-action {box-sizing:border-box;min-height:34px;padding:6px 12px !important;border:1px solid #aebdcc !important;border-radius:6px !important;background:#fff !important;color:#354659 !important;box-shadow:none !important;opacity:1;white-space:nowrap;cursor:pointer}\n.avahi-web-root button.avahi-action.primary {background:#5168d9 !important;border-color:#5168d9 !important;color:#fff !important}\n.avahi-web-root button.avahi-action.danger {background:#fff !important;border-color:#e4a3a5 !important;color:#bb3641 !important}\n.avahi-web-root button.avahi-action:disabled {opacity:.46 !important;cursor:not-allowed}\n.avahi-web-root button.avahi-action:focus-visible {outline:2px solid #5168d9;outline-offset:2px}\n.avahi-web-root .avahi-panel-head {display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px}\n.avahi-web-root .avahi-panel-note {margin:3px 0 0;color:var(--text-color-secondary,#637083);font-size:.93em;line-height:1.45}\n.avahi-web-root .avahi-table-scroll {overflow-x:auto;width:100%;border:1px solid rgba(130,145,160,.22);border-radius:8px;margin-top:10px}\n.avahi-web-root table.avahi-result-table {width:100% !important;min-width:560px;table-layout:fixed !important;border-collapse:collapse !important;border-spacing:0 !important;margin:0;background:transparent}\n.avahi-web-root .avahi-result-table tr {display:table-row !important;background:transparent !important}\n.avahi-web-root .avahi-result-table th,.avahi-web-root .avahi-result-table td {display:table-cell !important;box-sizing:border-box;text-align:left !important;vertical-align:middle;padding:10px 12px !important;border:0 !important;border-bottom:1px solid rgba(130,145,160,.18) !important;overflow-wrap:anywhere;word-break:normal}\n.avahi-web-root .avahi-result-table th {background:rgba(125,145,170,.1) !important;font-weight:600}\n.avahi-web-root .avahi-result-table tbody tr:last-child td {border-bottom:0 !important}\n.avahi-web-root .avahi-result-table tbody tr:nth-child(even) {background:rgba(125,145,170,.035) !important}\n@media (max-width:800px) {.avahi-web-root .avahi-service-grid {grid-template-columns:minmax(0,1fr) !important}.avahi-web-root .avahi-panel {padding:13px}}";
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
		var lastNode = E('div'), noticeNode = E('div'), scanFeedback = E('div');
		var authStateNode = E('div'), authCredentialNode = E('div');
		var busy = false, runtimeBusy = false, refreshing = false, authBusy = false, scanBusy = false;
		var scanButton;
		var authOutput = 'state=error';
		var manualButton;
		var currentStatus = {}, currentPackages = {};
		var groups = [
			{ id: 'avahi', label: 'Avahi', note: '用于发现 Android 无线调试动态端口', process: 'running', init: 'avahi-daemon', bins: [ ['avahi-daemon-bin','avahi-daemon'], ['avahi-browse-bin','avahi-browse'] ], start: 'start', stop: 'stop', enable: 'enable', disable: 'disable', packages: [ 'avahi-dbus-daemon', 'avahi-utils' ] },
			{ id: 'dbus', label: 'D-Bus', note: 'Avahi 的进程间通信依赖', process: 'dbus', init: 'dbus', bins: [ ['dbus-bin','dbus-daemon'] ], start: 'dbus-start', stop: 'dbus-stop', enable: 'dbus-enable', disable: 'dbus-disable', packages: [ 'dbus' ] }
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
		function locked() { return runtimeBusy || busy || refreshing || authBusy; }
		function actionButton(label, action, disabled, kind) {
			var blocked = !!disabled || locked();
			return E('button', {
				type: 'button',
				'class': 'avahi-action ' + (kind === 'danger' ? 'danger' : kind === 'positive' ? 'primary' : ''),
				// LuCI E() must receive null, not false, for an absent boolean attribute.
				disabled: blocked ? '' : null,
				click: function() { if (!blocked && !locked()) return action(); }
			}, [ label ]);
		}
		function serviceAction(group, operation, label) {
			if (locked()) return Promise.resolve();
			var perform = function() {
				if (locked()) return Promise.resolve();
				runtimeBusy = true;
				drawComponents();
				return control('service', [ operation ]).then(function() {
					alert(group.label + '：' + label + '成功。');
				}, function(e) {
					alert(group.label + '：' + e.message, true);
				}).then(refreshStatus).catch(function(e) {
					alert('状态回读失败：' + e.message, true);
				}).then(function() {
					runtimeBusy = false;
					drawComponents();
				});
			};
			if ([ 'stop', 'dbus-stop', 'disable', 'dbus-disable' ].indexOf(operation) < 0)
				return perform();
			var confirmed = false;
			ui.showModal('确认服务操作', [
				E('p', [ '即将对 ' + group.label + ' 执行「' + label + '」。停止 D-Bus 等基础服务可能影响依赖它的系统功能。' ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ '取消' ]), ' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						if (confirmed || locked()) return;
						confirmed = true;
						ui.hideModal();
						return perform();
					} }, [ '确认' ])
				])
			]);
		}
		function drawComponents() {
			if (manualButton) manualButton.disabled = locked();
			if (scanButton) scanButton.disabled = scanBusy || locked();
			renderAuth(authOutput);
			var st = currentStatus;
			var cards = groups.map(function(g) {
				var pkg = packageState(g), running = st[g.process] === 'yes';
				var init = st[g.init + '-init'] === 'yes', enabled = st[g.init + '-enabled'] === 'yes';
				var daemonBin = st[g.bins[0][0]] === 'yes';
				var missingBins = g.bins.filter(function(b) { return st[b[0]] !== 'yes'; }).map(function(b) { return b[1]; });
				var complete = pkg.state === 'complete' && !missingBins.length && init;
				var missing = pkg.missing;
				var packLabel = pkg.state === 'complete' ? (complete ? '' : '运行条件不完整') :
					pkg.state === 'partial' ? '部分安装' : pkg.state === 'absent' ? '未安装' : '状态未知';
				var runLabel = running ? '停止' : '启动';
				var runAction = running ? g.stop : g.start;
				var bootLabel = enabled ? '关闭自启' : '启用自启';
				var bootAction = enabled ? g.disable : g.enable;
				var packageAction = pkg.state === 'complete' ? 'upgrade' : 'install';
				var packageLabel = pkg.state === 'complete' ? '更新' :
					pkg.state === 'partial' ? '补齐安装' : '安装';
				var info = [];
				if (pkg.state !== 'complete' && pkg.state !== 'unknown' && missing.length)
					info.push(E('p', { style: 'margin:5px 0;' }, [ '缺少软件包：' + missing.join('、') ]));
				if (pkg.state === 'complete' && missingBins.length)
					info.push(E('p', { style: 'margin:5px 0;' }, [ '缺少运行文件：' + missingBins.join('、') ]));
				if (!init && pkg.state !== 'absent')
					info.push(E('p', { style: 'margin:5px 0;' }, [ '缺少服务启动脚本：' + g.init ]));
				var actions = E('div', {
					'class': 'avahi-action-row'
				}, [
					actionButton(runLabel, function() { return serviceAction(g, runAction, runLabel); },
						!init || (!running && !daemonBin), running ? 'danger' : 'positive'), ' ',
					actionButton(bootLabel, function() { return serviceAction(g, bootAction, bootLabel); },
						!init, 'normal'), ' ',
					actionButton(packageLabel, function() { return preview(packageAction, g.id); },
						pkg.state === 'unknown', 'positive'), ' ',
					actionButton('卸载', function() { return preview('remove', g.id); },
						pkg.state === 'absent' || pkg.state === 'unknown', 'danger')
				]);
				return E('div', { 'class': 'avahi-component-card' }, [
					E('div', { style: 'display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:start;' }, [
						E('div', [ E('h3', { style: 'margin:0 0 4px;' }, [ g.label ]),
							E('p', { style: 'margin:0;opacity:.8;' }, [ g.note ]) ]),
						packLabel ? statusMark(packLabel, pkg.state === 'absent' ? 'bad' : 'warn') : ''
					]),
					E('div', { style: 'margin:7px 0 8px;' }, [
						statusMark(running ? '● 运行中' : '○ 已停止', running ? 'ok' : 'idle'),
						statusMark(!init ? '启动脚本缺失' : enabled ? '已启用自启' : '未启用自启',
							!init ? 'bad' : enabled ? 'ok' : 'idle')
					]),
					E('div', { style: 'min-height:0;overflow-wrap:anywhere;color:var(--text-color-secondary,#826226);font-size:.93em;' }, info),
					E('div', { style: 'padding-top:7px;' }, [
						E('strong', [ '服务控制' ]), actions
					])
				]);
			});
			var runningCount = groups.filter(function(g) { return st[g.process] === 'yes'; }).length;
			summaryNode.replaceChildren(E('span', [ '运行中 ' + runningCount + '/2' ]));
			componentsNode.replaceChildren(
				E('div', { 'class': 'avahi-service-grid' }, cards)
			);
		}
		function refreshStatus() {
			if (refreshing) return Promise.resolve();
			refreshing = true;
			drawComponents();
			return Promise.all([ control('status'), control('package', [ 'list' ]) ]).then(function(data) {
				currentStatus = values(data[0]);
				currentPackages = inventory(data[1]);
			}).then(function() {
				refreshing = false;
				drawComponents();
			}, function(e) {
				refreshing = false;
				drawComponents();
				throw e;
			});
		}
		function manualRefresh() {
			if (busy || runtimeBusy || refreshing) return Promise.resolve();
			return refreshStatus().catch(function(e) { alert('状态刷新失败：' + e.message, true); });
		}
		function setBusy(on) {
			busy = on;
			drawComponents();
		}
		function execute(operation, group) {
			setBusy(true);
			return control('package', [ 'apply', operation, group ]).then(function() {
				alert('软件包操作成功，已重新检测状态。');
			}, function(e) {
				alert('软件包操作失败：' + e.message, true);
			}).then(refreshStatus).catch(function(e) {
				alert('操作后状态刷新失败：' + e.message, true);
			}).then(function() { setBusy(false); });
		}
		function preview(operation, group) {
			if (busy || runtimeBusy || refreshing || authBusy) return;
			setBusy(true);
			return control('package', [ 'plan', operation, group ]).then(function(result) {
				// Unlock after simulation, BEFORE showing the dialog. LuCI permits
				// dismissing a modal by Escape or its built-in close control.
				// No hidden busy state may outlive such a dismissed dialog.
				setBusy(false);
				var confirmed = false;
				ui.showModal('确认软件包操作', [
					E('p', [ 'SNAPSHOT 软件源可能已经变化，请核对模拟操作中的全部依赖变更；不会执行系统整体升级。' ]),
					E('p', [ '目标：' + group + ' / ' + operation ]),
					E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto' },
						[ result || '模拟结果未提出变更' ]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', click: function() { ui.hideModal(); } }, [ '取消' ]), ' ',
						E('button', { 'class': 'btn cbi-button-apply', click: function() {
							if (confirmed || busy || runtimeBusy || refreshing || authBusy) return;
							confirmed = true;
							ui.hideModal();
							return execute(operation, group);
						} }, [ '确认执行' ])
					])
				]);
			}).catch(function(e) {
				alert('软件包预览失败，未修改任何软件：' + e.message, true);
				setBusy(false);
			});
		}
		function renderAuth(output) {
			authOutput = output;
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
				E('div', { 'class': 'avahi-action-row' }, [
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
				'class': 'avahi-action' + (action === 'revoke' ? ' danger' : action === 'create' ? ' primary' : ''),
				disabled: (disabled || authBusy || busy || runtimeBusy || refreshing) ? '' : null,
				click: function() {
					if (disabled || authBusy || busy || runtimeBusy || refreshing) return;
					return confirmAuth(action);
				}
			}, [ label ]);
		}
		function applyAuth(action) {
			if (authBusy || busy || runtimeBusy || refreshing) return Promise.resolve();
			authBusy = true;
			drawComponents();
			return auth(action).then(function(out) {
				var info = values(out);
				if (action !== 'revoke') {
					if (!/^[0-9a-f]{64}$/.test(info.password || ''))
						throw new Error('账号可能已修改，但未收到有效的一次性凭据，请检查 RPCD 状态。');
					// Never erase an earlier, still-visible one-time credential
					// until a successful new value has been received.
					authCredentialNode.replaceChildren(
						E('p', { 'class': 'alert-message warning' }, [
							'请立即复制并妥善保存密码！页面刷新后无法再次查看。'
						]),
						E('p', [ 'NAS 专用用户名：', E('strong', [ info.username || 'easyadb' ]) ]),
						E('textarea', { readonly: '', rows: 2, 'class': 'cbi-input-textarea',
							style: 'max-width:100%;width:560px', value: info.password }),
						E('p', [ 'RPCD 即将重新加载。请在 EasyADB 中配置此凭据，不要使用路由器管理员密码。' ])
					);
				}
				else {
					authCredentialNode.replaceChildren();
					alert('NAS 专用授权已撤销，RPCD 会话将重新加载。', false);
				}
			}).catch(function(e) {
				alert('授权操作失败：' + e.message, true);
			}).then(refreshAuth).then(function() {
				authBusy = false;
				drawComponents();
			}, function(e) {
				authBusy = false;
				drawComponents();
				alert('读取账号状态失败：' + e.message, true);
			});
		}
		function confirmAuth(action) {
			if (authBusy || busy || runtimeBusy || refreshing) return;
			var warning = action === 'create'
				? '创建名为 easyadb 的最小权限 RPCD 账户，随机密码仅显示一次。'
				: action === 'rotate'
				? '将生成新的随机密码，必须同步更新 EasyADB 配置；重新加载 RPCD 后，旧密码不能用于再次登录。'
				: '仅撤销本组件管理的 easyadb 专用账号，RPCD 重新加载后不再授权新的 NAS 扫描请求。';
			var confirmed = false;
			ui.showModal('确认 NAS 授权操作', [
				E('p', [ warning ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ '取消' ]), ' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						if (confirmed || authBusy || busy || runtimeBusy || refreshing) return;
						confirmed = true;
						ui.hideModal();
						return applyAuth(action);
					} }, [ '确认执行' ])
				])
			]);
		}
		function renderLast(output) {
			if (!output) {
				lastNode.replaceChildren(E('p', { 'class': 'avahi-panel-note' }, [ '暂无已保存的发现结果。' ]));
				return;
			}
			var result;
			try { result = JSON.parse(output); }
			catch (e) {
				lastNode.replaceChildren(E('p', { 'class': 'avahi-panel-note' }, [ '最近一次扫描快照格式无效。' ]));
				return;
			}
			var seen = Object.create(null), records = [];
			(Array.isArray(result.devices) ? result.devices : []).forEach(function(d) {
				var key = JSON.stringify([d.instance || '', d.iface || '', d.address || '', d.port || '']);
				if (seen[key]) return;
				seen[key] = true;
				records.push(d);
			});
			var rows = records.map(function(d) {
				return E('tr', [
					cell(d.instance), cell(d.iface), cell(d.address), cell(d.port)
				]);
			});
			var table = E('div', { 'class': 'avahi-table-scroll' }, [
				E('table', { 'class': 'avahi-result-table' }, [
					E('colgroup', [
						E('col', { style: 'width:37%;' }), E('col', { style: 'width:19%;' }),
						E('col', { style: 'width:29%;' }), E('col', { style: 'width:15%;' })
					]),
					E('thead', [ E('tr', [
						E('th', [ '服务实例' ]), E('th', [ '网络接口' ]),
						E('th', [ 'IP 地址' ]), E('th', [ '端口' ])
					]) ]),
					E('tbody', rows)
				])
			]);
			lastNode.replaceChildren(
				E('p', { 'class': 'avahi-panel-note', style: 'margin:8px 0 2px;' }, [
					'最近成功扫描：' + (result.scanned_at ?
						new Date(result.scanned_at * 1000).toLocaleString() : '-') +
					'　·　发现端点：' + String(records.length)
				]),
				records.length ? table : E('p', { 'class': 'avahi-panel-note' }, [
					'本次未发现已发布的 ADB TLS 服务。'
				])
			);
			return records.length;
		}
		function scanMessage(message, error) {
			scanFeedback.replaceChildren(
				E('p', { role: 'status', style: 'margin:9px 0;overflow-wrap:anywhere;color:' +
					(error ? '#ac342b' : 'var(--text-color-high,#28673a)') + ';' }, [ message ])
			);
		}
		function reloadLast() {
			return snapshot().then(function(output) {
				renderLast(output);
				scanMessage('已读取最近一次发现记录。', false);
			}).catch(function(e) {
				renderLast('');
				scanMessage('无法读取最近记录：' + e.message, true);
			});
		}
		function scanOnce() {
			if (scanBusy || locked()) return Promise.resolve();
			scanBusy = true;
			scanButton.disabled = true;
			scanButton.textContent = '正在发现…';
			scanMessage('正在执行一次 Avahi 发现，请稍候（最多约 8 秒）……', false);
			return scan().then(function(output) {
				var result = JSON.parse(output);
				if (result.status !== 'ok' || !Array.isArray(result.devices))
					throw new Error('扫描返回数据格式不正确');
				var uniqueCount = renderLast(output);
				scanMessage('发现完成：本次检测到 ' + uniqueCount + ' 个 ADB 端点（已合并重复记录）。', false);
			}).catch(function(e) {
				scanMessage('发现失败：' + e.message, true);
			}).then(function() {
				scanBusy = false;
				scanButton.textContent = '立即发现 ADB';
				scanButton.disabled = locked();
			});
		}
		manualButton = E('button', { type: 'button', 'class': 'avahi-action', click: manualRefresh },
			[ '手动刷新组件状态' ]);
		scanButton = E('button', { type: 'button', 'class': 'avahi-action primary', click: scanOnce },
			[ '立即发现 ADB' ]);
		currentPackages = inventory(data[1]);
		currentStatus = values(data[0]);
		drawComponents();
		renderLast(data[2]);
		renderAuth(data[3]);
		return E('div', { 'class': 'avahi-web-root' }, [
			E('style', [ VIEW_STYLE ]),
			E('div', { 'class': 'avahi-panel-head', style: 'margin:0 0 14px;' }, [
				E('div', [
					E('h2', { style: 'margin:0 0 4px;' }, [ 'Avahi / EasyADB 发现代理' ]),
					E('p', { 'class': 'avahi-panel-note' }, [ '管理员可手动发现 ADB，NAS 可通过专用授权接口按需扫描。' ])
				]),
				manualButton
			]),
			noticeNode,
			E('section', { 'class': 'avahi-panel' }, [
				E('div', { 'class': 'avahi-panel-head' }, [
					E('div', [ E('h3', [ '组件与服务管理' ]),
						E('p', { 'class': 'avahi-panel-note' }, [ '仅在进入页面、主动刷新和操作结束后检测状态。' ]) ]),
					summaryNode
				]),
				componentsNode
			]),
			E('section', { 'class': 'avahi-panel' }, [
				E('div', { 'class': 'avahi-panel-head' }, [
					E('div', [ E('h3', [ 'ADB 设备发现' ]),
						E('p', { 'class': 'avahi-panel-note' }, [
							'立即发现：重新扫描无线调试端口；刷新结果：只读取最近一次缓存。'
						]) ]),
					E('div', { 'class': 'avahi-action-row', style: 'margin:0;' }, [
						scanButton,
						E('button', { type: 'button', 'class': 'avahi-action', click: reloadLast }, [ '刷新结果' ])
					])
				]),
				scanFeedback, lastNode
			]),
			E('section', { 'class': 'avahi-panel' }, [
				E('div', { 'class': 'avahi-panel-head' }, [
					E('div', [ E('h3', [ 'NAS 接口授权' ]),
						E('p', { 'class': 'avahi-panel-note' }, [
							'专用 easyadb 账号仅允许执行一次 scan。凭据创建或轮换后仅显示一次。'
						]) ])
				]),
				authStateNode, authCredentialNode
			])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
