#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --check htdocs/luci-static/resources/view/avahi-web/overview.js
for src in root/usr/libexec/luci-avahi-web root/usr/libexec/luci-avahi-scan scripts/build-ipk.sh scripts/build-apk-sdk.sh scripts/check-router.sh; do
    sh -n "$src"
done
test -x root/usr/libexec/luci-avahi-web
test -x root/usr/libexec/luci-avahi-scan

python3 - <<'PY'
import json, pathlib
root=pathlib.Path("root/usr/share")
menu=json.loads((root/"luci/menu.d/luci-app-avahi-web.json").read_text())
acl=json.loads((root/"rpcd/acl.d/luci-app-avahi-web.json").read_text())
assert menu["admin/services/avahi-web"]["depends"]["acl"] == ["luci-app-avahi-web"]
admin=acl["luci-app-avahi-web"]
nas=acl["luci-avahi-easyadb"]
assert nas["read"]["file"] == {"/usr/libexec/luci-avahi-scan scan":["exec"]}
assert not nas.get("write")
assert "/usr/libexec/luci-avahi-scan last" in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-scan scan" not in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-web package list" in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-web package plan *" in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-web package apply *" in admin["write"]["file"]
assert "unauthenticated" not in acl
code=pathlib.Path("htdocs/luci-static/resources/view/avahi-web/overview.js").read_text()
assert "snapshot()" in code and "[ 'last' ]" in code
assert "callScan('scan')" not in code and "'browse'" not in code
assert "scanOnce" not in code and "refreshScanLog" not in code
assert "config-set" not in code and "enable-reflector" not in code
scanner=pathlib.Path("root/usr/libexec/luci-avahi-scan").read_text()
assert "scan|last)" in scanner and "events.log" not in scanner and "log_event" not in scanner
controller=pathlib.Path("root/usr/libexec/luci-avahi-web").read_text()
assert "browse)" not in controller and "config-set)" not in controller
make=pathlib.Path("Makefile").read_text()
assert "+avahi-dbus-daemon" not in make and "+avahi-utils" not in make
assert "+rpcd-mod-file" in make and "+uhttpd-mod-ubus" in make
PY
# Unsupported actions must fail before any filesystem or network change.
if root/usr/libexec/luci-avahi-scan log >/dev/null 2>&1; then
    echo "Removed logging API still accessible" >&2; exit 1
fi
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
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
        case "$2" in add|del|upgrade) printf 'Simulation: %s\n' "$*"; exit 0 ;; *) exit 1 ;; esac ;;
    add|del|upgrade|update) echo "Applied: $*"; exit 0 ;;
    *) exit 1 ;;
esac
EOF
chmod +x "$TEMP/mock-apk"
MOCK_APK_LOG="$TEMP/apk.log"
export MOCK_APK_LOG
sed 's@^APK=$(command -v apk || true)$@APK=__MOCK_APK__@' root/usr/libexec/luci-avahi-web |
    sed "s@__MOCK_APK__@$TEMP/mock-apk@" > "$TEMP/helper"
chmod +x "$TEMP/helper"
"$TEMP/helper" package list | grep -q "$(printf 'dbus\tinstalled\t')"
"$TEMP/helper" package list | grep -q "$(printf 'avahi-utils\tabsent\t')"
"$TEMP/helper" package plan install avahi | grep -q Simulation
"$TEMP/helper" package plan remove dbus | grep -q Simulation
"$TEMP/helper" package plan upgrade umdns | grep -q Simulation
"$TEMP/helper" package apply install avahi | grep -q Applied
"$TEMP/helper" package apply upgrade umdns | grep -q Applied
"$TEMP/helper" package apply remove avahi | grep -q Applied
"$TEMP/helper" package refresh | grep -q Applied
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
for op in dbus-stop umdns-reboot browse config-set; do
    if "$TEMP/helper" service "$op" >/dev/null 2>&1; then
        echo "Unsupported service option accepted: $op" >&2; exit 1
    fi
done
sh scripts/build-ipk.sh
ar t dist/luci-app-avahi-web_0.4.0-1_all.ipk | grep -qx 'data.tar.gz'
ar p dist/luci-app-avahi-web_0.4.0-1_all.ipk control.tar.gz |
    tar -xzOf - ./control |
    grep -qx 'Depends: luci-base, rpcd-mod-file, libubox, uhttpd-mod-ubus'
echo 'minimal agent smoke tests passed'
