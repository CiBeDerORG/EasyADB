#!/bin/sh
# Build an architecture-independent opkg IPK without needing a target SDK.
# For release builds (especially apk based OpenWrt), use the OpenWrt SDK Makefile.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
NAME=luci-app-avahi-web
VERSION=0.2.0-1
for cmd in ar tar gzip mktemp; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Missing $cmd" >&2; exit 1; }
done
TEMP=$(mktemp -d)
trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
mkdir -p "$TEMP/control" "$TEMP/data" "$ROOT/dist"
cp -R root/. "$TEMP/data/"
mkdir -p "$TEMP/data/www"
cp -R htdocs/. "$TEMP/data/www/"
cat > "$TEMP/control/control" <<EOC
Package: $NAME
Version: $VERSION
Architecture: all
Maintainer: CiBeDerORG
License: Apache-2.0
Section: luci
Priority: optional
Depends: luci-base, rpcd-mod-file
Description: LuCI dashboard for Avahi configuration and Android ADB discovery
EOC
cat > "$TEMP/control/postinst" <<'EOC'
#!/bin/sh
# Installation intentionally never starts Avahi or stops umdns.
[ -n "${IPKG_INSTROOT:-}" ] || rm -f /tmp/luci-indexcache
exit 0
EOC
chmod 0755 "$TEMP/control/postinst"
printf '2.0\n' > "$TEMP/debian-binary"
(cd "$TEMP/control" && tar --owner=0 --group=0 --numeric-owner -czf "$TEMP/control.tar.gz" .)
(cd "$TEMP/data" && tar --owner=0 --group=0 --numeric-owner -czf "$TEMP/data.tar.gz" .)
rm -f "$ROOT/dist/${NAME}_${VERSION}_all.ipk"
(cd "$TEMP" && ar cr "$ROOT/dist/${NAME}_${VERSION}_all.ipk" debian-binary control.tar.gz data.tar.gz)
echo "Built $ROOT/dist/${NAME}_${VERSION}_all.ipk"
