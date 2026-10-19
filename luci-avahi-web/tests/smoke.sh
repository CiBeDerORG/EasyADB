#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --check htdocs/luci-static/resources/view/avahi-web/overview.js
node tests/ui-status.js
for src in root/usr/libexec/luci-avahi-web root/usr/libexec/luci-avahi-scan root/usr/libexec/luci-avahi-auth scripts/build-apk-sdk.sh; do
    sh -n "$src"
done
test -x root/usr/libexec/luci-avahi-web
test -x root/usr/libexec/luci-avahi-scan
test -x root/usr/libexec/luci-avahi-auth

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
assert "/usr/libexec/luci-avahi-scan scan" in admin["write"]["file"]
assert "/usr/libexec/luci-avahi-scan scan" not in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-web package list" in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-web package plan *" in admin["read"]["file"]
assert "/usr/libexec/luci-avahi-web package apply *" in admin["write"]["file"]
assert "unauthenticated" not in acl
assert "/usr/libexec/luci-avahi-auth status" in admin["read"]["file"]
for action in ("create", "rotate", "revoke"):
    assert "/usr/libexec/luci-avahi-auth "+action in admin["write"]["file"]
assert "luci-avahi-auth" not in repr(nas)
auth=pathlib.Path("root/usr/libexec/luci-avahi-auth").read_text()
assert "openssl" in auth and "passwd -6 -stdin" in auth
assert "rand -hex 32" in auth and 'easyadb' in auth
assert "luci-avahi-easyadb" in auth
code=pathlib.Path("htdocs/luci-static/resources/view/avahi-web/overview.js").read_text()
assert "snapshot()" in code and "[ 'last' ]" in code
assert "callScan('scan')" not in code and "'browse'" not in code
assert "function scanOnce(" in code and "function scan() {" in code
assert "refreshScanLog" not in code
assert "function renderAuth(" in code and "function confirmAuth(" in code
assert "auth('status')" in code and "authCredentialNode" in code
assert "config-set" not in code and "enable-reflector" not in code
scanner=pathlib.Path("root/usr/libexec/luci-avahi-scan").read_text()
assert "scan|last)" in scanner and "events.log" not in scanner and "log_event" not in scanner
assert "ls -ldn" in scanner and "id -u" in scanner
assert "set +u\nJSON_PREFIX=\n. /usr/share/libubox/jshn.sh" in scanner
assert 'json_dump > "$OUT"\nset -u' in scanner
assert "Scan state directory is not root-owned" not in scanner
controller=pathlib.Path("root/usr/libexec/luci-avahi-web").read_text()
assert "\n    browse) " not in controller and "\n    config-set) " not in controller
assert "avahi-daemon-bin=" in controller and "avahi-browse-bin=" in controller
assert '"$unit" "$(unit_flag "$unit")"' in controller
assert "function drawComponents(" in code and "function packageState(" in code
assert "组件与服务管理" in code and "缺少软件包" in code
assert "umdns" not in code and "umdns" not in controller
assert "disabled: blocked ? '' : null" in code
assert "disabled: (disabled || authBusy || busy || runtimeBusy || refreshing) ? '' : null" in code
assert "手动刷新组件状态" in code and "grid-template-columns" in code
assert "poll.add(" not in code and "'require poll'" not in code
assert "cbi-button-positive" in code and "cbi-button-negative" in code
assert "Only authenticated EasyADB requests" not in code
make=pathlib.Path("Makefile").read_text()
assert "+avahi-dbus-daemon" not in make and "+avahi-utils" not in make
assert "+rpcd-mod-file" in make and "+uhttpd-mod-ubus" in make and "+openssl-util" in make
assert "include $(INCLUDE_DIR)/package.mk" in make and "include $(TOPDIR)/feeds/luci/luci.mk" not in make
assert "PKGARCH:=all" in make
PY
# Unsupported actions must fail before any filesystem or network change.
if root/usr/libexec/luci-avahi-scan log >/dev/null 2>&1; then
    echo "Removed logging API still accessible" >&2; exit 1
fi
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
# On minimal OpenWrt systems stat -c can be missing. Test a real user-owned
# 0700 directory with a failing stat command and a numeric ls -ldn fallback.
mkdir -m 0700 "$TEMP/scan-state" "$TEMP/mock-bin"
printf '%s\n' '{"status":"ok","devices":[]}' > "$TEMP/scan-state/last-scan.json"
cat > "$TEMP/mock-bin/stat" <<'EOF'
#!/bin/sh
exit 127
EOF
chmod +x "$TEMP/mock-bin/stat"
sed -e "s@^STATE=/tmp/luci-avahi-web\$@STATE=$TEMP/scan-state@" \
    -e "s@^PATH=/usr/sbin:/usr/bin:/sbin:/bin\$@PATH=$TEMP/mock-bin:/usr/sbin:/usr/bin:/sbin:/bin@" \
    root/usr/libexec/luci-avahi-scan > "$TEMP/mock-scan"
chmod +x "$TEMP/mock-scan"
"$TEMP/mock-scan" last | grep -q '"status":"ok"'
cat > "$TEMP/mock-bin/ls" <<'EOF'
#!/bin/sh
echo 'drwx------ 2 999999 999999 80 Jan 1 00:00 /tmp/fake-state'
EOF
chmod +x "$TEMP/mock-bin/ls"
if "$TEMP/mock-scan" last >/dev/null 2>"$TEMP/scan-owner-error"; then
    echo 'Scanner accepted a directory owned by another UID' >&2; exit 1
fi
grep -q 'owner UID 999999 differs from scanner UID' "$TEMP/scan-owner-error"
rm -f "$TEMP/mock-bin/ls"

# Regression: OpenWrt jshn references JSON_PREFIX/JSON_UNSET before setting them.
# Reproduce this with no predeclared JSON_* variables in a complete scanner run.
mkdir -m 0700 "$TEMP/scan-json-state" "$TEMP/json-bin"
cat > "$TEMP/mock-jshn.sh" <<'EOF'
json_init() {
    [ -z "$JSON_PREFIX" ] && [ -z "$JSON_UNSET" ]
    JSON_UNSET=
}
json_add_string() { :; }
json_add_int() { :; }
json_add_array() { :; }
json_add_object() { :; }
json_close_object() { :; }
json_close_array() { :; }
json_dump() {
    [ -z "$JSON_PREFIX" ] && [ -z "$JSON_UNSET" ]
    printf '{"status":"ok","devices":[],"count":0}\n'
}
EOF
cat > "$TEMP/json-bin/avahi-browse" <<'EOF'
#!/bin/sh
printf '%s\n' '=;br-lan;IPv4;adb-test;_adb-tls-connect._tcp;local;phone.local;192.168.1.66;37819;'
EOF
cat > "$TEMP/json-bin/pidof" <<'EOF'
#!/bin/sh
[ "$1" = avahi-daemon ]
EOF
chmod +x "$TEMP/json-bin/avahi-browse" "$TEMP/json-bin/pidof"
sed -e "s@^STATE=/tmp/luci-avahi-web\$@STATE=$TEMP/scan-json-state@" \
    -e "s@^PATH=/usr/sbin:/usr/bin:/sbin:/bin\$@PATH=$TEMP/json-bin:/usr/sbin:/usr/bin:/sbin:/bin@" \
    -e "s@/usr/bin/avahi-browse@$TEMP/json-bin/avahi-browse@g" \
    -e "s@/usr/share/libubox/jshn.sh@$TEMP/mock-jshn.sh@g" \
    root/usr/libexec/luci-avahi-scan > "$TEMP/mock-json-scan"
chmod +x "$TEMP/mock-json-scan"
env -u JSON_PREFIX -u JSON_UNSET "$TEMP/mock-json-scan" scan > "$TEMP/scan-json-result"
grep -q '"status":"ok"' "$TEMP/scan-json-result"
test -f "$TEMP/scan-json-state/last-scan.json"
env -u JSON_PREFIX -u JSON_UNSET "$TEMP/mock-json-scan" last | grep -q '"status":"ok"'
test ! -e "$TEMP/scan-json-state/scan.lock"

cat > "$TEMP/mock-apk" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_APK_LOG"
case "$1" in
    info)
        case "$2" in
            -e) [ "$3" = dbus ] || {
                [ "${MOCK_AVAHI_DAEMON:-0}" = 1 ] && [ "$3" = avahi-dbus-daemon ]
            } ;;
            -v) echo "PACKAGE DESCRIPTION SHOULD NEVER BE SHOWN AS A VERSION" ;;
            *) exit 1 ;;
        esac ;;
    list)
        [ "$2" = --installed ] && [ "$3" = --manifest ] || exit 1
        printf '%s %s\n' "$4" '1.0-r1' ;;
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
PACKAGE_LIST=$("$TEMP/helper" package list)
printf '%s\n' "$PACKAGE_LIST" | grep -q "$(printf 'dbus\tinstalled\t')"
printf '%s\n' "$PACKAGE_LIST" | grep -qx "$(printf 'dbus\tinstalled\t1.0-r1')"
if printf '%s\n' "$PACKAGE_LIST" | grep -q 'PACKAGE DESCRIPTION'; then
    echo 'Verbose apk info was mistaken for the package version' >&2; exit 1
fi
grep -qx -- 'list --installed --manifest dbus' "$TEMP/apk.log"
if grep -q '^info -v ' "$TEMP/apk.log"; then
    echo 'Do not use apk info -v to determine package versions' >&2; exit 1
fi
"$TEMP/helper" package list | grep -q "$(printf 'avahi-utils\tabsent\t')"
"$TEMP/helper" package plan install avahi | grep -q Simulation
"$TEMP/helper" package plan remove dbus | grep -q Simulation
"$TEMP/helper" package plan upgrade dbus | grep -q Simulation
"$TEMP/helper" package apply install avahi | grep -q Applied
"$TEMP/helper" package apply upgrade dbus | grep -q Applied
"$TEMP/helper" package apply remove avahi | grep -q Applied
"$TEMP/helper" package refresh | grep -q Applied
grep -qx -- '--simulate add avahi-dbus-daemon avahi-utils' "$TEMP/apk.log"
grep -qx -- 'add avahi-dbus-daemon avahi-utils' "$TEMP/apk.log"
grep -qx -- 'upgrade dbus' "$TEMP/apk.log"
grep -qx -- 'del avahi-dbus-daemon avahi-utils' "$TEMP/apk.log"
grep -qx -- 'update' "$TEMP/apk.log"
# The previous system may have umdns installed/running. It is out of scope:
# neither an Avahi installation nor an Avahi upgrade may inspect it.
MOCK_AVAHI_DAEMON=1 "$TEMP/helper" package plan install avahi | grep -q Simulation
MOCK_AVAHI_DAEMON=1 "$TEMP/helper" package apply install avahi | grep -q Applied
grep -qx -- '--simulate add avahi-utils' "$TEMP/apk.log"
grep -qx -- 'add avahi-utils' "$TEMP/apk.log"
"$TEMP/helper" package plan upgrade avahi | grep -q Simulation
if "$TEMP/helper" package plan install umdns >/dev/null 2>&1; then
    echo 'Removed umdns package target is still accepted' >&2; exit 1
fi
if "$TEMP/helper" package apply remove umdns >/dev/null 2>&1; then
    echo 'Removed umdns package target can be uninstalled' >&2; exit 1
fi
! "$TEMP/helper" package list | grep -q '^umdns'
if "$TEMP/helper" service umdns-stop >/dev/null 2>&1; then
    echo 'Removed umdns service command is still accepted' >&2; exit 1
fi

if "$TEMP/helper" package apply install 'avahi;reboot' >/dev/null 2>&1; then
    echo 'Arbitrary package name accepted' >&2; exit 1
fi
if "$TEMP/helper" package apply upgrade all >/dev/null 2>&1; then
    echo 'Global upgrade accepted' >&2; exit 1
fi
if "$TEMP/helper" package apply remove dbus --force >/dev/null 2>&1; then
    echo 'Extra APK flag accepted' >&2; exit 1
fi
for op in dbus-restart umdns-enable browse config-set; do
    if "$TEMP/helper" service "$op" >/dev/null 2>&1; then
        echo "Unsupported service option accepted: $op" >&2; exit 1
    fi
done

# Simulate RPCD UCI operations without touching the runner's /etc/config.
cat > "$TEMP/mock-uci" <<'EOF'
#!/usr/bin/env python3
import json,os,sys
path=os.environ['MOCK_UCI_STATE']
args=sys.argv[1:]
if args and args[0]=='-q': args.pop(0)
data=json.load(open(path)) if os.path.exists(path) else {}
cmd=args.pop(0)
def output(s):
    print(s)
    sys.exit(0)
if cmd=='get':
    key=args[0]
    if key=='rpcd.easyadb':
        if data.get('type'): output(data['type'])
    else:
        value=data.get(key.rsplit('.',1)[-1])
        if value: output(value)
    sys.exit(1)
if cmd=='show':
    print("rpcd.root.username='root'")
    if data.get('username'): print("rpcd.easyadb.username='%s'"%data['username'])
    sys.exit(0)
if cmd=='changes':
    sys.exit(0)
if cmd=='set':
    key,value=args[0].split('=',1)
    data['type' if key=='rpcd.easyadb' else key.rsplit('.',1)[-1]]=value
elif cmd=='add_list':
    key,value=args[0].split('=',1)
    data[key.rsplit('.',1)[-1]]=value
elif cmd=='delete':
    data={}
elif cmd in ('commit','revert'):
    pass
else: sys.exit(1)
with open(path,'w') as fh: json.dump(data,fh)
EOF
chmod +x "$TEMP/mock-uci"
printf "config login 'root'\n" > "$TEMP/rpcd.conf"
printf '#!/bin/sh\nexit 0\n' > "$TEMP/mock-rpcd-init"
chmod +x "$TEMP/mock-rpcd-init"
MOCK_UCI_STATE="$TEMP/rpcd-data.json"
export MOCK_UCI_STATE
sed \
  -e "s@^UCI=/sbin/uci\$@UCI=$TEMP/mock-uci@" \
  -e "s@^RPCD_INIT=/etc/init.d/rpcd\$@RPCD_INIT=$TEMP/mock-rpcd-init@" \
  -e "s@/etc/config/rpcd@$TEMP/rpcd.conf@g" \
  -e "s@/tmp/luci-avahi-auth.lock@$TEMP/auth.lock@g" \
  root/usr/libexec/luci-avahi-auth > "$TEMP/mock-auth"
chmod +x "$TEMP/mock-auth"
"$TEMP/mock-auth" status | grep -qx 'state=absent'
"$TEMP/mock-auth" create > "$TEMP/create.out"
grep -qx 'state=managed' "$TEMP/create.out"
first=$(sed -n 's/^password=//p' "$TEMP/create.out")
[ "$(printf %s "$first" | wc -c)" -eq 64 ]
printf %s "$first" | grep -Eq '^[a-f0-9]{64}$'
"$TEMP/mock-auth" status | grep -qx 'state=managed'
! "$TEMP/mock-auth" status | grep -q '^password='
python3 - <<'PY'
import json,os
data=json.load(open(os.environ['MOCK_UCI_STATE']))
assert data['username']=='easyadb'
assert data['read']=='luci-avahi-easyadb'
assert 'write' not in data
assert data['password'].startswith('$6$')
PY
"$TEMP/mock-auth" rotate > "$TEMP/rotate.out"
second=$(sed -n 's/^password=//p' "$TEMP/rotate.out")
[ "$first" != "$second" ]
"$TEMP/mock-auth" revoke | grep -qx 'state=absent'
"$TEMP/mock-auth" status | grep -qx 'state=absent'
if "$TEMP/mock-auth" rotate >/dev/null 2>&1; then
    echo "Credential rotated for an absent account" >&2; exit 1
fi
if "$TEMP/mock-auth" create extra >/dev/null 2>&1; then
    echo "Account helper accepted arbitrary arguments" >&2; exit 1
fi

echo 'minimal agent smoke tests passed'
