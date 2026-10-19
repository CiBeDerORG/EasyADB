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
assert '/usr/libexec/luci-avahi-web package list' in acl['luci-app-avahi-web']['read']['file']
assert '/usr/libexec/luci-avahi-web package plan *' in acl['luci-app-avahi-web']['read']['file']
assert '/usr/libexec/luci-avahi-web package apply *' in acl['luci-app-avahi-web']['write']['file']
assert '/usr/libexec/luci-avahi-web package refresh' in acl['luci-app-avahi-web']['write']['file']
makefile=pathlib.Path('Makefile').read_text()
assert '+avahi-dbus-daemon' not in makefile and '+avahi-utils' not in makefile
js=pathlib.Path('htdocs/luci-static/resources/view/avahi-web/overview.js').read_text()
assert 'function planPackage(' in js and 'function displayPackages(' in js
assert "[ 'apply', operation, target ]" in js and "[ 'refresh' ]" in js
PY
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
mkdir -p "$TEMP/avahi"
cat > "$TEMP/mock-apk" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_APK_LOG"
case "$1" in
    info)
        case "$2" in
            -e) [ "$3" = dbus ] || [ "$3" = umdns ] ;;
            -v) echo "$3-1.0-r1" ;;
            *) exit 1 ;;
        esac ;;
    --simulate)
        case "$2" in add|del|upgrade)
            printf 'Simulation: %s\n' "$*"; exit 0 ;;
            *) exit 1 ;; esac ;;
    add|del|upgrade|update) echo "Applied: $*"; exit 0 ;;
    *) echo 'Unknown APK command' >&2; exit 1 ;;
esac
EOF
chmod +x "$TEMP/mock-apk"
MOCK_APK_LOG="$TEMP/apk.log"
export MOCK_APK_LOG
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
    root/usr/libexec/luci-avahi-web | \
    sed 's@^APK=$(command -v apk || true)$@APK=__MOCK_APK__@' | \
    sed "s@__MOCK_APK__@$TEMP/mock-apk@" > "$TEMP/helper"
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
"$TEMP/helper" package list | grep -q "$(printf 'dbus\tinstalled\t')"
"$TEMP/helper" package list | grep -q "$(printf 'avahi-utils\tabsent\t')"
"$TEMP/helper" package plan install avahi | grep -q 'Simulation'
"$TEMP/helper" package plan remove dbus | grep -q 'Simulation'
"$TEMP/helper" package plan upgrade umdns | grep -q 'Simulation'
"$TEMP/helper" package apply install avahi | grep -q 'Applied'
"$TEMP/helper" package apply upgrade umdns | grep -q 'Applied'
"$TEMP/helper" package apply remove avahi | grep -q 'Applied'
"$TEMP/helper" package refresh | grep -q 'Applied'
grep -qx -- '--simulate add avahi-dbus-daemon avahi-utils' "$TEMP/apk.log"
grep -qx -- 'add avahi-dbus-daemon avahi-utils' "$TEMP/apk.log"
grep -qx -- 'upgrade umdns' "$TEMP/apk.log"
grep -qx -- 'del avahi-dbus-daemon avahi-utils' "$TEMP/apk.log"
grep -qx -- 'update' "$TEMP/apk.log"
if "$TEMP/helper" package apply install 'umdns;reboot' >/dev/null 2>&1; then
    echo 'Arbitrary package name accepted' >&2; exit 1
fi
if "$TEMP/helper" package apply upgrade all >/dev/null 2>&1; then
    echo 'Global upgrade accepted' >&2; exit 1
fi
if "$TEMP/helper" package apply remove dbus --force >/dev/null 2>&1; then
    echo 'Extra APK flag accepted' >&2; exit 1
fi
sh scripts/build-ipk.sh
ar t dist/luci-app-avahi-web_0.2.0-1_all.ipk | grep -qx 'data.tar.gz'
ar p dist/luci-app-avahi-web_0.2.0-1_all.ipk control.tar.gz | tar -xzOf - ./control | grep -qx 'Depends: luci-base, rpcd-mod-file'
! "$TEMP/helper" service umdns-reboot >/dev/null 2>&1
! "$TEMP/helper" service dbus-reboot >/dev/null 2>&1
echo 'smoke tests passed'
