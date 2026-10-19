'use strict';
'require view';
'require fs';
'require ui';
'require poll';

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
		var statusNode = E('div'), packagesNode = E('div');
		var lastNode = E('div'), noticeNode = E('div');
		var authStateNode = E('div'), authCredentialNode = E('div');
		var operationOutput = E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto' });
		var busy = false, packageButtons = [];
		var currentStatus = {}, currentPackages = {}, runtimeBusy = false;
		var groups = [
			{ id: 'avahi', label: 'Avahi', packages: [ 'avahi-dbus-daemon', 'avahi-utils' ] },
			{ id: 'dbus', label: 'D-Bus', packages: [ 'dbus' ] },
			{ id: 'umdns', label: 'umdns', packages: [ 'umdns' ] }
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
		function serviceButton(label, action, disabled, kind) {
			return E('button', { type: 'button',
				'class': 'cbi-button ' + (kind === 'danger' ? 'cbi-button-negative' :
					kind === 'positive' ? 'cbi-button-positive' : 'cbi-button-neutral'),
				disabled: disabled || runtimeBusy || busy,
				click: function() {
					if (disabled || runtimeBusy || busy) return;
					var perform = function() {
						runtimeBusy = true;
						drawRuntime();
						return control('service', [ action ]).then(function() {
							alert('服务操作已完成，状态已重新检测。');
						}).catch(function(e) {
							alert('服务操作失败：' + e.message, true);
						}).then(refreshStatus).then(function() {
							runtimeBusy = false; drawRuntime();
						}, function(e) {
							runtimeBusy = false; drawRuntime(); alert(e.message, true);
						});
					};
					if ([ 'stop', 'umdns-stop', 'umdns-disable' ].indexOf(action) < 0)
						return perform();
					ui.showModal('确认服务操作', [
						E('p', [ '停止或禁用 mDNS 服务可能影响局域网中其他设备的发现功能。' ]),
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
		function drawRuntime() {
			var s = currentStatus;
			var specs = [
				{ key: 'avahi', label: 'Avahi', process: 'running', init: 'avahi-daemon', bins: [
					{ field: 'avahi-daemon-bin', name: 'avahi-daemon' },
					{ field: 'avahi-browse-bin', name: 'avahi-browse' }
				], start: 'start', stop: 'stop', enable: 'enable', disable: 'disable' },
				{ key: 'dbus', label: 'D-Bus', process: 'dbus', init: 'dbus', bins: [
					{ field: 'dbus-bin', name: 'dbus-daemon' }
				], start: 'dbus-start' },
				{ key: 'umdns', label: 'umdns', process: 'umdns', init: 'umdns', bins: [
					{ field: 'umdns-bin', name: 'umdns' }
				], start: 'umdns-start', stop: 'umdns-stop', enable: 'umdns-enable', disable: 'umdns-disable' }
			];
			var items = [];
			specs.forEach(function(spec) {
				var group = groups.find(function(g) { return g.id === spec.key; });
				var pkg = packageState(group);
				var running = s[spec.process] === 'yes';
				var init = s[spec.init + '-init'] === 'yes';
				var boot = s[spec.init + '-enabled'] === 'yes';
				var missingBins = spec.bins.filter(function(b) { return s[b.field] !== 'yes'; })
					.map(function(b) { return b.name; });
				var complete = pkg.state === 'complete' && missingBins.length === 0 && init;
				var activeConflict = spec.key === 'avahi' ? s.umdns === 'yes' :
					spec.key === 'umdns' ? s.running === 'yes' : false;
				var installText = pkg.state === 'complete' ?
					(missingBins.length || !init ? '已装包，但运行文件不完整' : '安装完整') :
					pkg.state === 'partial' ? '部分安装' :
					pkg.state === 'absent' ? '未安装' : '尚未取得安装状态';
				items.push(E('div', { style: 'padding:10px 0;border-bottom:1px solid var(--border-color-medium, #ddd);' }, [
					E('div', [ E('strong', { style: 'font-size:1.06em;margin-right:12px;' }, [ spec.label ]),
						statusMark(installText, complete ? 'ok' : pkg.state === 'partial' || pkg.state === 'complete' ? 'warn' : pkg.state === 'absent' ? 'bad' : 'idle'),
						statusMark(running ? '运行中' : '已停止', running ? 'ok' : 'idle'),
						statusMark(!init ? '缺少启动脚本' : boot ? '开机自启：开启' : '开机自启：关闭',
							!init ? 'bad' : boot ? 'ok' : 'idle') ]),
					pkg.missing.length && pkg.state !== 'unknown' ?
						E('div', { style: 'margin:4px 0;' }, [ '缺少软件包：' + pkg.missing.join('、') ]) : '',
					missingBins.length ? E('div', { style: 'margin:4px 0;' },
						[ '缺少运行文件：' + missingBins.join('、') ]) : '',
					E('div', { style: 'margin-top:7px;' }, [
						serviceButton('启动', spec.start, !complete || running || activeConflict, 'positive'), ' ',
						spec.stop ? serviceButton('停止', spec.stop, !running, 'danger') : '', ' ',
						spec.enable ? serviceButton('启用开机自启', spec.enable, !complete || boot, 'positive') : '', ' ',
						spec.disable ? serviceButton('关闭开机自启', spec.disable, !init || !boot, 'neutral') : ''
					])
				]));
			});
			if (s.running === 'yes' && s.umdns === 'yes') {
				items.unshift(E('div', { 'class': 'alert-message warning', style: 'margin-bottom:10px;' },
					[ '检测到 Avahi 与 umdns 进程同时运行，可能发生 mDNS 5353 端口冲突。建议只保留其中一项服务；本页面不会擅自停止任何服务。' ]));
			}
			statusNode.replaceChildren(
				E('p', [ '页面会检测软件包、运行文件、进程和开机自启状态。安装软件包不等于服务一定已经启动。' ]),
				E('div', items),
				E('div', { style: 'margin-top:12px;' }, [
					E('button', { type: 'button', 'class': 'cbi-button cbi-button-action',
						disabled: runtimeBusy || busy, click: refreshStatus }, [ '重新检测全部状态' ])
				])
			);
		}
		function renderStatus(output) {
			currentStatus = values(output);
			drawRuntime();
		}
		function refreshStatus() {
			return Promise.all([ control('status'), control('package', [ 'list' ]) ]).then(function(data) {
				currentPackages = inventory(data[1]);
				renderStatus(data[0]);
				renderPackages(data[1]);
			}).catch(function(e) { alert('状态检测失败：' + e.message, true); });
		}
		function setBusy(on) {
			busy = on;
			packageButtons.forEach(function(button) {
				button.disabled = on || button._notAvailable;
			});
			drawRuntime();
		}
		function pkgButton(label, group, action, disabled) {
			var button = E('button', { type: 'button', 'class': 'cbi-button ' + (action === 'install' ? 'cbi-button-positive' :
					action === 'remove' ? 'cbi-button-negative' : 'cbi-button-action'),
				disabled: disabled, click: function() { return preview(action, group); }
			}, [ label ]);
			button._notAvailable = disabled;
			packageButtons.push(button);
			return button;
		}
		function renderPackages(output) {
			currentPackages = inventory(output);
			packageButtons = [];
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', [ '组件' ]), E('th', [ '安装状态' ]),
					E('th', [ '软件包 / 版本' ]), E('th', [ '操作' ])
				])
			]);
			groups.forEach(function(group) {
				var state = packageState(group);
				var count = group.packages.length - state.missing.length;
				var details = group.packages.map(function(pkg) {
					var v = currentPackages[pkg];
					return E('div', [
						statusMark(v && v.installed ? '已安装' : '缺失', v && v.installed ? 'ok' : 'bad'),
						pkg + '：' + (v && v.installed ? v.version || '版本未知' : '未安装')
					]);
				});
				var label = state.state === 'complete' ? '全部已安装' :
					state.state === 'partial' ? '部分安装（' + count + '/' + group.packages.length + '）' :
					state.state === 'absent' ? '未安装' : '未知';
				table.appendChild(E('tr', { 'class': 'tr' }, [
					cell(group.label),
					E('td', [
						statusMark(label, state.state === 'complete' ? 'ok' :
							state.state === 'partial' ? 'warn' : state.state === 'absent' ? 'bad' : 'idle'),
						state.missing.length && state.state !== 'unknown' ? E('div', [ '缺少：' + state.missing.join('、') ]) : ''
					]),
					E('td', details),
					E('td', [
						pkgButton(state.state === 'partial' ? '补齐安装' : '安装',
							group.id, 'install', state.state === 'complete' || state.state === 'unknown'), ' ',
						pkgButton('更新', group.id, 'upgrade', state.state !== 'complete'), ' ',
						pkgButton('卸载', group.id, 'remove',
							state.state === 'absent' || state.state === 'unknown')
					])
				]));
			});
			packagesNode.replaceChildren(table);
			if (busy) setBusy(true);
			else drawRuntime();
		}
		function refreshPackages() {
			return control('package', [ 'list' ]).then(renderPackages).catch(function(e) { alert(e.message, true); });
		}
		function execute(operation, group) {
			setBusy(true);
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
			if (busy) return;
			setBusy(true);
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
			if (busy) return;
			ui.showModal(_('更新 APK 软件源索引'), [
				E('p', [ _('仅刷新软件源索引，不升级已安装的软件包。') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ _('取消') ]), ' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						ui.hideModal();
						setBusy(true);
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
		currentPackages = inventory(data[1]);
		renderStatus(data[0]);
		renderPackages(data[1]);
		renderLast(data[2]);
		renderAuth(data[3]);
		poll.add(function() {
			if (runtimeBusy || busy) return Promise.resolve();
			return refreshStatus();
		}, 20);
		return E('div', [
			E('h2', [ _('Avahi / EasyADB 局域网发现代理') ]),
			E('p', [ _('只有通过接口身份及权限校验的 EasyADB 请求才能触发 mDNS 扫描；本页面只展示结果，不会主动扫描。') ]),
			noticeNode,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ '运行状态与服务控制' ]), statusNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('最近一次 NAS 扫描') ]),
				E('p', [ _('路由器仅在 /tmp 保存最近一次扫描快照，重启自动清空；正式设备列表由 EasyADB 持久化管理。') ]),
				E('button', { type: 'button', 'class': 'cbi-button', click: reloadLast }, [ _('刷新最近结果') ]),
				lastNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('三大组件安装与管理') ]),
				E('p', [ _('独立管理 Avahi（守护进程与发现工具）、D-Bus、umdns。传递依赖交给 APK 自动解析，变更前请确认模拟安装结果。') ]),
				E('button', { type: 'button', 'class': 'cbi-button', click: refreshIndex }, [ _('刷新软件源索引') ]), ' ',
				E('button', { type: 'button', 'class': 'cbi-button', click: refreshPackages }, [ _('重新检查安装状态') ]),
				packagesNode,
				E('h4', [ _('最近一次软件包操作输出') ]), operationOutput
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('NAS 接口授权') ]),
				E('p', [ _('在此创建、轮换或撤销专用 RPCD 账号。NAS 仅允许执行 scan，不具备安装软件包或管理服务的权限；接口沿用系统 /ubus 鉴权。') ]),
				authStateNode, authCredentialNode,
				E('p', [ _('随机凭据仅展示一次，本页面不会回显已保存的密码哈希，也不会自动将 /ubus 暴露到互联网。') ])
			])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
