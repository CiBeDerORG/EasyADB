'use strict';
'require view';
'require fs';
'require ui';
'require poll';

var HELPER = '/usr/libexec/luci-avahi-web';

function call(action, args) {
	return fs.exec(HELPER, [ action ].concat(args || [])).then(function(res) {
		if (res.code !== 0)
			throw new Error((res.stderr || res.stdout || _('Command failed')).trim());
		return res.stdout || '';
	});
}

function keyValues(data) {
	var result = {};
	String(data || '').split('\n').forEach(function(line) {
		var index = line.indexOf('=');
		if (index > 0)
			result[line.slice(0, index)] = line.slice(index + 1);
	});
	return result;
}

// avahi-browse -p escapes semicolons; plain split(';') corrupts TXT/name fields.
function splitBrowseLine(line) {
	var fields = [], current = '', escaped = false;
	for (var i = 0; i < line.length; i++) {
		var ch = line.charAt(i);
		if (escaped) {
			current += '\\' + ch;
			escaped = false;
		}
		else if (ch === '\\') {
			escaped = true;
		}
		else if (ch === ';') {
			fields.push(current);
			current = '';
		}
		else {
			current += ch;
		}
	}
	fields.push(current);
	return fields;
}

function parseBrowse(output) {
	var found = {}, results = [];
	String(output || '').split('\n').forEach(function(line) {
		if (line.slice(0, 2) !== '=;')
			return;
		var f = splitBrowseLine(line);
		if (f.length < 9 || !/^\d{1,5}$/.test(f[8]))
			return;
		var entry = { iface: f[1], proto: f[2], name: f[3], type: f[4], host: f[6], ip: f[7], port: f[8] };
		var key = [ entry.iface, entry.proto, entry.name, entry.type, entry.ip, entry.port ].join('|');
		if (!found[key]) {
			found[key] = true;
			results.push(entry);
		}
	});
	return results;
}

function cell(value) { return E('td', [ value || '-' ]); }
function checked(value) { return value === 'yes'; }

return view.extend({
	load: function() {
		return Promise.all([ call('status'), call('config-get').catch(function() { return ''; }), call('package', [ 'list' ]) ]);
	},

	render: function(data) {
		var self = this;
		var conf = keyValues(data[1]);
		var configReady = data[1] !== '';
		var packages = E('div');
		var packageLog = E('pre', { 'style': 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto' });
		var packageBusy = false;
		var packageButtons = [];
		var status = E('div');
		var discover = E('div');
		var error = E('div');
		var mode = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'adb' }, [ '_adb-tls-connect._tcp' ]),
			E('option', { value: 'pairing' }, [ '_adb-tls-pairing._tcp' ]),
			E('option', { value: 'all' }, [ _('All mDNS services') ])
		]);
		var ipv4 = E('input', { type: 'checkbox', checked: checked(conf['use-ipv4']) });
		var ipv6 = E('input', { type: 'checkbox', checked: checked(conf['use-ipv6']) });
		var reflector = E('input', { type: 'checkbox', checked: checked(conf['enable-reflector']) });
		var reflectIPv = E('input', { type: 'checkbox', checked: checked(conf['reflect-ipv']) });
		var interfaces = E('input', { type: 'text', 'class': 'cbi-input-text',
			value: conf['allow-interfaces'] || '', placeholder: 'br-lan' });

		function message(msg, isError) {
			error.replaceChildren(msg ? E('div', { 'class': isError ? 'alert-message warning' : 'alert-message notice' }, [ msg ]) : '');
		}

		function showStatus(text) {
			var s = keyValues(text);
			status.replaceChildren(E('p', [
				_('Avahi installed') + ': ' + (s.installed === 'yes' ? _('Yes') : _('No')) + '  |  ',
				_('Avahi running') + ': ' + (s.running === 'yes' ? _('Yes') : _('No')) + '  |  ',
				'umdns: ' + (s.umdns === 'yes' ? _('Running') : _('Stopped'))
			]));
			if (s.umdns === 'yes')
				status.appendChild(E('p', { 'class': 'alert-message warning' }, [
					_('umdns is running. This page will not stop it automatically. Stop/disable umdns manually before starting Avahi to avoid mDNS conflicts.')
				]));
		}

		function pkgInventory(output) {
			var result = {};
			String(output || '').split('\n').forEach(function(line) {
				var cols = line.split('\t');
				if (cols.length === 3 && /^[a-z0-9-]+$/.test(cols[0]))
					result[cols[0]] = { installed: cols[1] === 'installed', version: cols[2] };
			});
			return result;
		}

		function busyPackages(state) {
			packageBusy = state;
			packageButtons.forEach(function(btn) {
				btn.disabled = state || btn._normallyDisabled;
			});
		}

		function packageButton(label, target, operation, disabled) {
			var btn = E('button', {
				type: 'button',
				'class': operation === 'remove' ? 'cbi-button cbi-button-negative' : 'cbi-button',
				disabled: disabled,
				click: function() { return planPackage(operation, target); }
			}, [ label ]);
			btn._normallyDisabled = disabled;
			packageButtons.push(btn);
			return btn;
		}

		var groups = [
			{ key: 'avahi', name: 'Avahi', pkgs: [ 'avahi-dbus-daemon', 'avahi-utils' ],
				note: _('Includes the D-Bus daemon and avahi-browse tools.') },
			{ key: 'dbus', name: 'D-Bus', pkgs: [ 'dbus' ],
				note: _('May be required by Avahi and other system services.') },
			{ key: 'umdns', name: 'umdns', pkgs: [ 'umdns' ],
				note: _('OpenWrt built-in mDNS implementation; check for port 5353 conflicts.') }
		];

		function displayPackages(output) {
			var inventory = pkgInventory(output);
			packageButtons = [];
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', [ _('Component') ]), E('th', [ _('Installed packages / versions') ]),
					E('th', [ _('Actions') ])
				])
			]);
			groups.forEach(function(group) {
				var installedCount = group.pkgs.filter(function(name) {
					return inventory[name] && inventory[name].installed;
				}).length;
				var versions = group.pkgs.map(function(name) {
					var info = inventory[name];
					return E('div', [ name + ': ' + (info && info.installed ?
						info.version || _('Installed') : _('Not installed')) ]);
				});
				var controls = E('td', [
					packageButton(_('Install'), group.key, 'install', installedCount === group.pkgs.length), ' ',
					packageButton(_('Update'), group.key, 'upgrade', installedCount !== group.pkgs.length), ' ',
					packageButton(_('Uninstall'), group.key, 'remove', installedCount === 0)
				]);
				table.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', [ E('strong', [ group.name ]), E('div', [ group.note ]) ]),
					E('td', versions), controls
				]));
			});
			packages.replaceChildren(table);
			if (packageBusy)
				busyPackages(true);
		}

		function refreshPackages() {
			return call('package', [ 'list' ]).then(displayPackages).catch(function(e) {
				message(_('Failed to refresh package status: ') + e.message, true);
			});
		}

		function refreshConfiguration() {
			return call('config-get').then(function(text) {
				var next = keyValues(text);
				ipv4.checked = checked(next['use-ipv4']);
				ipv6.checked = checked(next['use-ipv6']);
				reflector.checked = checked(next['enable-reflector']);
				reflectIPv.checked = checked(next['reflect-ipv']);
				interfaces.value = next['allow-interfaces'] || '';
				configReady = true;
				save.disabled = false;
			}).catch(function() {
				configReady = false;
				save.disabled = true;
			});
		}

		function applyPackage(operation, target) {
			busyPackages(true);
			packageLog.textContent = _('Executing selected operation…');
			return call('package', [ 'apply', operation, target ]).then(function(text) {
				packageLog.textContent = text;
				message(_('Selected package operation finished. Review the output below.'));
			}).catch(function(e) {
				packageLog.textContent = e.message;
				message(_('Package operation failed. No force flags were used.'), true);
			}).then(function() {
				return Promise.all([ refreshPackages(), refreshStatus(), refreshConfiguration() ]);
			}).then(function() { busyPackages(false); });
		}

		function planPackage(operation, target) {
			if (packageBusy)
				return;
			busyPackages(true);
			packageLog.textContent = _('Checking dependency transaction…');
			return call('package', [ 'plan', operation, target ]).then(function(plan) {
				packageLog.textContent = plan;
				var warning = operation === 'remove'
					? _('Uninstalling a package may remove orphaned dependencies. Check the simulated transaction carefully. Stop active services first.')
					: operation === 'upgrade'
					? _('This is a package-scoped upgrade, not a system upgrade. SNAPSHOT package feeds can change: inspect versions and take a backup first.')
					: _('Installation uses only the router configured APK repositories. It does not automatically enable or start a daemon.');
				ui.showModal(_('Confirm package operation'), [
					E('p', [ warning ]),
					E('p', [ _('Target: ') + target + ' / ' + operation ]),
					E('pre', { style: 'max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere' }, [ plan || _('No changes proposed') ]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', click: function() { ui.hideModal(); busyPackages(false); } }, [ _('Cancel') ]),
						' ',
						E('button', { 'class': 'btn cbi-button-apply', click: function() {
							ui.hideModal();
							return applyPackage(operation, target);
						} }, [ _('Confirm and execute') ])
					])
				]);
			}).catch(function(e) {
				packageLog.textContent = e.message;
				message(_('Package simulation failed; nothing was changed.'), true);
				busyPackages(false);
			});
		}

		function refreshFeedIndexes() {
			if (packageBusy)
				return;
			ui.showModal(_('Refresh package indexes'), [
				E('p', [ _('Update APK repository indexes only. No packages will be upgraded. Use firmware-matched SNAPSHOT repositories.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', click: ui.hideModal }, [ _('Cancel') ]),
					' ',
					E('button', { 'class': 'btn cbi-button-apply', click: function() {
						ui.hideModal();
						busyPackages(true);
						packageLog.textContent = _('Refreshing repository indexes…');
						return call('package', [ 'refresh' ]).then(function(text) {
							packageLog.textContent = text;
							message(_('Package indexes refreshed.'));
						}).catch(function(e) {
							packageLog.textContent = e.message;
							message(_('Index refresh failed.'), true);
						}).then(refreshPackages).then(function() { busyPackages(false); });
					} }, [ _('Refresh indexes') ])
				])
			]);
		}

		function showBrowse(output) {
			var rows = parseBrowse(output);
			if (!rows.length) {
				discover.replaceChildren(E('p', [ _('No resolved services were found. Ensure Android native Wireless debugging is enabled; traditional adb tcpip 5555 may not advertise mDNS.') ]));
				return;
			}
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', [ _('Name') ]), E('th', [ _('Service') ]), E('th', [ _('Interface') ]),
					E('th', [ _('Address') ]), E('th', [ _('Port') ])
				])
			]);
			rows.forEach(function(row) {
				table.appendChild(E('tr', { 'class': 'tr' }, [
					cell(row.name), cell(row.type), cell(row.iface + ' / ' + row.proto), cell(row.ip), cell(row.port)
				]));
			});
			discover.replaceChildren(table);
		}

		function refreshStatus() { return call('status').then(showStatus).catch(function(e) { message(e.message, true); }); }
		function refreshBrowse() {
			return call('browse', [ mode.value ]).then(function(text) {
				showBrowse(text);
			}).catch(function(e) {
				discover.replaceChildren(E('p', { 'class': 'alert-message warning' }, [ e.message ]));
			});
		}
		function action(name) {
			message(_('Working…'));
			return call('service', [ name ]).then(function() {
				message(_('Service action completed.'));
				return refreshStatus();
			}).catch(function(e) { message(e.message, true); });
		}
		function actionButton(label, actionName, css) {
			return E('button', { type: 'button', 'class': css || 'cbi-button',
				click: function() { return action(actionName); } }, [ label ]);
		}
		var save = E('button', { type: 'button', 'class': 'cbi-button cbi-button-apply', disabled: !configReady,
			click: function() {
				if (!ipv4.checked && !ipv6.checked) {
					message(_('IPv4 and IPv6 cannot both be disabled.'), true);
					return;
				}
				message(_('Saving Avahi configuration…'));
				return call('config-set', [ ipv4.checked ? 'yes' : 'no', ipv6.checked ? 'yes' : 'no',
					interfaces.value.trim(), reflector.checked ? 'yes' : 'no', reflectIPv.checked ? 'yes' : 'no' ])
					.then(function(text) { message(text.trim() + ' ' + _('Restart Avahi to apply the changes.')); })
					.catch(function(e) { message(e.message, true); });
			}
		}, [ _('Save configuration') ]);

		showStatus(data[0]);
		displayPackages(data[2]);
		var root = E('div', {}, [
			E('h2', [ _('Avahi / ADB Discovery') ]),
			E('p', [ _('Discover Android Wireless debugging services on this OpenWrt LAN. The service records remain local; this application does not forward multicast over EasyTier or report anything to NAS.') ]),
			status, error,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('Package management (APK)') ]),
				E('p', [ _('Manage Avahi, D-Bus and umdns independently. Installation and removal are opt-in; no forced dependency removal or blanket firmware upgrade is used.') ]),
				E('button', { type: 'button', 'class': 'cbi-button', click: refreshFeedIndexes }, [ _('Refresh package indexes') ]),
				' ', E('button', { type: 'button', 'class': 'cbi-button', click: refreshPackages }, [ _('Refresh installed status') ]),
				packages, E('h4', [ _('Last package operation') ]), packageLog
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('Daemon control') ]),
				E('div', { 'class': 'cbi-page-actions' }, [
					actionButton(_('Start'), 'start', 'cbi-button cbi-button-apply'), ' ',
					actionButton(_('Stop'), 'stop', 'cbi-button cbi-button-reset'), ' ',
					actionButton(_('Restart'), 'restart'), ' ',
					E('button', { type: 'button', 'class': 'cbi-button', click: refreshStatus }, [ _('Refresh status') ])
				])
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('Service discovery') ]),
				E('p', [ _('A resolved record shows the advertised IP and current port, but it does not by itself prove that ADB pairing or TCP connectivity succeeds.') ]),
				mode, ' ',
				E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: refreshBrowse }, [ _('Discover now') ]),
				discover
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', [ _('Avahi configuration') ]),
				E('p', [ _('Changes are written to the existing /etc/avahi/avahi-daemon.conf. A backup is retained. Save first, then restart Avahi manually.') ]),
				E('p', [ E('label', [ ipv4, ' ', _('Enable IPv4') ]) ]),
				E('p', [ E('label', [ ipv6, ' ', _('Enable IPv6') ]) ]),
				E('p', [ E('label', [ _('Allowed interfaces (comma-separated; blank = Avahi default): '), interfaces ]) ]),
				E('p', [ E('label', [ reflector, ' ', _('Enable mDNS reflector (off by default)') ]) ]),
				E('p', [ E('label', [ reflectIPv, ' ', _('Reflect between IPv4 and IPv6') ]) ]),
				E('p', [ _('For the EasyADB discovery experiment, br-lan and reflector disabled are recommended. Enabling reflection can expose mDNS advertisements across networks.') ]),
				save
			])
		]);
		if (configReady)
			refreshBrowse();
		else
			discover.replaceChildren(E('p', [ _('Install Avahi first, then start its daemon to discover services.') ]));
		poll.add(function() { return refreshStatus(); }, 20);
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
