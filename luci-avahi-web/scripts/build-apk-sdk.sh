#!/bin/sh
# Build a native APK using a firmware-matched OpenWrt SDK, never by renaming IPK.
# Usage from SDK root: sh /path/to/build-apk-sdk.sh /path/to/luci-avahi-web
set -eu
[ "$#" -eq 1 ] || { echo 'Usage: build-apk-sdk.sh /absolute/path/to/luci-avahi-web' >&2; exit 2; }
[ -r rules.mk ] && [ -d package ] && [ -r .config ] || {
    echo 'Run from the extracted, configured ImmortalWrt/OpenWrt SDK root.' >&2; exit 1;
}
SRC=$(cd "$1" && pwd -P) || exit 1
[ -r "$SRC/Makefile" ] && [ -f "$SRC/root/usr/libexec/luci-avahi-web" ] || {
    echo 'Source directory is incomplete.' >&2; exit 1;
}
# Use the SDK matching the installed SNAPSHOT; rolling feeds may be incompatible.
[ -r feeds/luci/luci.mk ] || {
    echo 'Install the matching LuCI feed in this SDK before compiling.' >&2; exit 1;
}
if [ -e package/luci-avahi-web ] || [ -L package/luci-avahi-web ]; then
    [ "$(readlink -f package/luci-avahi-web)" = "$SRC" ] || {
        echo 'package/luci-avahi-web already exists and points elsewhere; not overwriting it.' >&2; exit 1;
    }
else
    ln -s "$SRC" package/luci-avahi-web
fi
sed -i '/^CONFIG_PACKAGE_luci-app-avahi-web=/d; /^# CONFIG_PACKAGE_luci-app-avahi-web is not set/d' .config
printf '%s\n' 'CONFIG_PACKAGE_luci-app-avahi-web=m' >> .config
make defconfig
if ! grep -qx 'CONFIG_USE_APK=y' .config; then
    echo 'This SDK is not configured for APK; refusing to create an IPK for an APK router.' >&2
    exit 1
fi
make package/luci-avahi-web/compile V=s
find bin -type f -name 'luci-app-avahi-web-*.apk' -print
