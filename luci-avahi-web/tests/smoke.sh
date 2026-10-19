#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node --check htdocs/luci-static/resources/view/avahi-web/overview.js
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
assert "scanOnce" not in code and "refreshScanLog" not in code
assert "function renderAuth(" in code and "function confirmAuth(" in code
assert "auth('status')" in code and "authCredentialNode" in code
assert "config-set" not in code and "enable-reflector" not in code
scanner=pathlib.Path("root/usr/libexec/luci-avahi-scan").read_text()
assert "scan|last)" in scanner and "events.log" not in scanner and "log_event" not in scanner
controller=pathlib.Path("root/usr/libexec/luci-avahi-web").read_text()
assert "browse)" not in controller and "config-set)" not in controller
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
printf %s "$first" | grep -Eq '^[a-f0-9]{64}

"$TEMP/mock-auth" status | grep -qx 'state=managed'
! "$TEMP/mock-auth" status | grep -q '^password='
python3 - <<'PY'
import json,os
data=json.load(open(os.environ['MOCK_UCI_STATE']))
assert data['username']=='easyadb'
assert data['read']=='luci-avahi-easyadb'
assert 'write' not in data
assert data['password'].startswith('$6
)
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
