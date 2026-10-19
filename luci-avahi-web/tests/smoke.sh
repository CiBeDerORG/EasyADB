#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --check htdocs/luci-static/resources/view/avahi-web/overview.js
sh -n root/usr/libexec/luci-avahi-web
sh -n scripts/build-ipk.sh
sh -n scripts/build-apk-sdk.sh
test -x root/usr/libexec/luci-avahi-web
sh -n scripts/check-router.sh
python3 - <<'PY'
import json, pathlib
root=pathlib.Path('root/usr/share')
menu=json.loads((root/'luci/menu.d/luci-app-avahi-web.json').read_text())
acl=json.loads((root/'rpcd/acl.d/luci-app-avahi-web.json').read_text())
assert menu['admin/services/avahi-web']['depends']['acl']==['luci-app-avahi-web']
assert menu['admin/services/avahi-web']['action']['path']=='avahi-web/overview'
assert 'luci-app-avahi-web' in acl
PY
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
mkdir -p "$TEMP/avahi"
cat > "$TEMP/avahi/avahi-daemon.conf" <<'EOC'
[server]
use-ipv4=yes
use-ipv6=no
# Preserve this setting.
check-response-ttl=no
[publish]
publish-addresses=yes
[reflector]
enable-reflector=no
reflect-ipv=no
EOC
sed "s@^CONF=/etc/avahi/avahi-daemon.conf\$@CONF=$TEMP/avahi/avahi-daemon.conf@" \
    root/usr/libexec/luci-avahi-web > "$TEMP/helper"
chmod +x "$TEMP/helper"
"$TEMP/helper" config-get | grep -qx 'use-ipv6=no'
"$TEMP/helper" config-set yes yes br-lan no no >/dev/null
"$TEMP/helper" config-get | grep -qx 'allow-interfaces=br-lan'
grep -qx 'check-response-ttl=no' "$TEMP/avahi/avahi-daemon.conf"
grep -qx 'publish-addresses=yes' "$TEMP/avahi/avahi-daemon.conf"
test -f "$TEMP/avahi/avahi-daemon.conf.bak-luci-avahi-web"
if "$TEMP/helper" config-set yes no 'br-lan;touch /tmp/pwn' no no >/dev/null 2>&1; then
    echo 'Invalid interface was accepted' >&2; exit 1
fi
if "$TEMP/helper" config-set no no br-lan no no >/dev/null 2>&1; then
    echo 'Both IP families disabled was accepted' >&2; exit 1
fi
"$TEMP/helper" config-set yes no '' no no >/dev/null
! grep -q '^allow-interfaces=' "$TEMP/avahi/avahi-daemon.conf"
! "$TEMP/helper" service 'restart;reboot' >/dev/null 2>&1
sh scripts/build-ipk.sh
ar t dist/luci-app-avahi-web_0.1.0-1_all.ipk | grep -qx 'data.tar.gz'
echo 'smoke tests passed'
