'use strict';
'require view';
'require fs';
'require ui';

var HELPER = '/usr/libexec/luci-avahi-web';
var SCANNER = '/usr/libexec/luci-avahi-scan';

function command(program, args) {
	return fs.exec(program, args).then(function(result) {
		if (result.code !== 0)
			throw new Error((result.stderr || result.stdout || _('Operation failed')).trim());
		return result.stdout || '';
	});
}
function control(action, args) { return command(HELPER, [ action ].concat(args || [])); }
function snapshot() { return command(SCANNER, [ 'last' ]); }
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
			snapshot().catch(function() { return ''; })
		]);
	},
	render: function(data) {
		var statusNode = E('div'), packagesNode = E('div');
		var lastNode = E('div'), noticeNode = E('div');
		var operationOutput = E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto' });
		var busy = false, packageButtons = [];
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
		function renderStatus(output) {
			var s = values(output);
			statusNode.replaceChildren(E('p', [
				'Avahi: ' + (s.running === 'yes' ? _('Running') : _('Stopped')) + ' / ',
				'D-Bus: ' + (s.dbus === 'yes' ? _('Running') : _('Stopped')) + ' / ',
				'umdns: ' + (s.umdns === 'yes' ? _('Running') : _('Stopped')),
				E('span', [ ' | ' + _('Boot: ') + 'Avahi ' + (s['avahi-daemon-enabled'] === 'yes' ? _('On') : _('Off')) +
					', umdns ' + (s['umdns-enabled'] === 'yes' ? _('On') : _('Off')) ])
			]));
			if (s.running === 'yes' && s.umdns === 'yes')
				statusNode.appendChild(E('p', { 'class': 'alert-message warning' }, [
					_('Both mDNS daemons are running. Resolve the UDP 5353 conflict before scanning.')
				]));
		}
		function refreshStatus() {
			return control('status').then(renderStatus).catch(function(e) { alert(e.message, true); });
		}
		function serviceButton(label, action) {
			return E('button', { type: 'button', 'class': 'cbi-button',
				click: function() {
					var perform = function() {
						return control('service', [ action ]).then(function() {
							alert(_('Service action completed.'));
							return refreshStatus();
						}).catch(function(e) { alert(e.message, true); });
					};
					if ([ 'stop', 'umdns-stop', 'umdns-disable' ].indexOf(action) < 0)
						return perform();
					ui.showModal(_('Confirm service action'), [
						E('p', [ _('Changing mDNS services may interrupt discovery for other clients.') ]),
						E('p', [ action ]),
						E('div', { 'class': 'right' }, [
							E('button', { 'class': 'btn', click: ui.hideModal }, [ _('Cancel') ]), ' ',
							E('button', { 'class': 'btn cbi-button-apply', click: function() {
								ui.hideModal();
								return perform();
							} }, [ _('Confirm') ])
						])
					]);
				}
			}, [ label ]);
		}
		function setBusy(on) {
			busy = on;
			packageButtons.forEach(function(button) {
				button.disabled = on || button._notAvailable;
			});
		}
		function pkgButton(label, group, action, disabled) {
			var button = E('button', { type: 'button', 'class': 'cbi-button',
				disabled: disabled, click: function() { return preview(action, group); }
			}, [ label ]);
			button._notAvailable = disabled;
			packageButtons.push(button);
			return button;
		}
		function renderPackages(output) {
			var installed = inventory(output);
			packageButtons = [];
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', [ _('Component') ]), E('th', [ _('Packages / version') ]), E('th', [ _('Actions') ])
				])
			]);
			groups.forEach(function(group) {
				var count = group.packages.filter(function(pkg) {
					return installed[pkg] && installed[pkg].installed;
				}).length;
				var details = group.packages.map(function(pkg) {
					var v = installed[pkg];
					return E('div', [ pkg + ': ' + (v && v.installed ? v.version || _('Installed') : _('Not installed')) ]);
				});
				table.appendChild(E('tr', { 'class': 'tr' }, [
					cell(group.label),
					E('td', details),
					E('td', [
						pkgButton(_('Install'), group.id, 'install', count === group.packages.length), ' ',
						pkgButton(_('Update'), group.id, 'upgrade', count !== group.packages.length), ' ',
						pkgButton(_('Uninstall'), group.id, 'remove', count === 0)
					])
				]));
			});
			packagesNode.replaceChildren(table);
			if (busy) setBusy(true);
		}
		function refreshPackages() {
			return control('package', [ 'list' ]).then(renderPackages).catch(function(e) { alert(e.message, true); });
		}
		function execute(operation, group) {
			setBusy(true);
			operationOutput.textContent = _('Executing operation…');
			return control('package', [ 'apply', operation, group ]).then(function(result) {
				operationOutput.textContent = result;
				alert(_('Package operation completed. See output below.'));
			}).catch(function(e) {
				operationOutput.textContent = e.message;
				alert(_('Package operation failed; no force flags were used.'), true);
			}).then(function() {
				return Promise.all([ refreshPackages(), refreshStatus() ]);
			}).then(function() { setBusy(false); }, function(e) {
				setBusy(false); alert(e.message, true);
			});
		}
		function preview(operation, group) {
			if (busy) return;
			setBusy(true);
			operationOutput.textContent = _('Checking APK dependency transaction…');
			return control('package', [ 'plan', operation, group ]).then(function(result) {
				operationOutput.textContent = result;
				ui.showModal(_('Confirm APK transaction'), [
					E('p', [ _('SNAPSHOT repositories may have changed. Inspect every proposed dependency change; no full-system upgrade is performed.') ]),
					E('p', [ _('Target: ') + group + ' / ' + operation ]),
					E('pre', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto' },
						[ result || _('No changes proposed') ]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', click: function() { ui.hideModal(); setBusy(false); } }, [ _('Cancel') ]), ' ',
						E('button', { 'class': 'btn cbi-button-apply', click: function() {
							ui.hideModal();
							return execute(operation, group);
						} }, [ _('Confirm') ])
					])
				]);
			}).catch(function(e) {
				operationOutput.textContent = e.message;
				alert(_('Transaction simulation failed; nothing changed.'), true);
				setBusy(false);
			});
		}
		function refreshIndex() {
			if (busy) return;
			ui.showModal(_('Refresh APK indexes'), [
				E('p', [ _('This only refreshes repository indexes; it does not upgrade installed packages.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ _('Cancel') ]), ' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						ui.hideModal();
						setBusy(true);
						return control('package', [ 'refresh' ]).then(function(out) {
							operationOutput.textContent = out;
						}).catch(function(e) {
							operationOutput.textContent = e.message;
							alert(e.message, true);
						}).then(refreshPackages).then(function() { setBusy(false); },
							function(e) { setBusy(false); alert(e.message, true); });
					} }, [ _('Confirm') ])
				])
			]);
		}
		function renderLast(output) {
			if (!output) {
				lastNode.replaceChildren(E('p', [ _('No successful NAS-triggered scan is cached.') ]));
				return;
			}
			var result;
			try { result = JSON.parse(output); }
			catch (e) {
				lastNode.replaceChildren(E('p', { 'class': 'alert-message warning' }, [ _('The last snapshot is invalid.') ]));
				return;
			}
			var records = Array.isArray(result.devices) ? result.devices : [];
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', [ _('Service instance') ]), E('th', [ _('Interface') ]),
					E('th', [ _('IP') ]), E('th', [ _('Port') ])
				])
			]);
			records.forEach(function(d) {
				table.appendChild(E('tr', { 'class': 'tr' }, [
					cell(d.instance), cell(d.iface), cell(d.address), cell(d.port)
				]));
			});
			lastNode.replaceChildren(
				E('p', [ _('Last successful scan: ') + (result.scanned_at ?
					new Date(result.scanned_at * 1000).toLocaleString() : '-') + ' | ' +
					_('Endpoints: ') + String(records.length) ]),
				records.length ? table : E('p', [ _('No advertised ADB TLS service was resolved.') ])
			);
		}
		function reloadLast() {
			return snapshot().then(renderLast).catch(function() { renderLast(''); });
		}
		renderStatus(data[0]);
		renderPackages(data[1]);
		renderLast(data[2]);
		return E('div', [
			E('h2', [ _('Avahi / EasyADB Agent') ]),
			E('p', [ _('Only authenticated EasyADB requests trigger mDNS discovery. This page never starts a scan.') ]),
			noticeNode,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('Runtime') ]), statusNode,
				E('h4', [ _('Avahi') ]),
				serviceButton(_('Start'), 'start'), ' ', serviceButton(_('Stop'), 'stop'), ' ',
				serviceButton(_('Enable at boot'), 'enable'), ' ', serviceButton(_('Disable at boot'), 'disable'),
				E('h4', [ _('umdns') ]),
				serviceButton(_('Start'), 'umdns-start'), ' ', serviceButton(_('Stop'), 'umdns-stop'), ' ',
				serviceButton(_('Enable at boot'), 'umdns-enable'), ' ', serviceButton(_('Disable at boot'), 'umdns-disable'),
				E('h4', [ _('D-Bus') ]),
				serviceButton(_('Start D-Bus'), 'dbus-start'), ' ',
				E('button', { type: 'button', 'class': 'cbi-button', click: refreshStatus }, [ _('Refresh status') ])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('Latest NAS-triggered scan') ]),
				E('p', [ _('One volatile snapshot is stored in /tmp. This page can only read it; EasyADB owns the durable device registry.') ]),
				E('button', { type: 'button', 'class': 'cbi-button', click: reloadLast }, [ _('Refresh displayed result') ]),
				lastNode
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('APK package management') ]),
				E('p', [ _('Avahi (daemon + utilities), D-Bus and umdns are managed separately. APK resolves transitive dependencies; review simulations before changes.') ]),
				E('button', { type: 'button', 'class': 'cbi-button', click: refreshIndex }, [ _('Refresh repository index') ]), ' ',
				E('button', { type: 'button', 'class': 'cbi-button', click: refreshPackages }, [ _('Refresh package status') ]),
				packagesNode,
				E('h4', [ _('Last package command output') ]), operationOutput
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('API authorization') ]),
				E('p', [ _('The existing /ubus RPCD session login and dedicated luci-avahi-easyadb read ACL gate the scan command. Provision a separate non-admin RPCD login before connecting NAS. No anonymous scan, webhook, or separate listening port is enabled.') ])
			])
		]);
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
