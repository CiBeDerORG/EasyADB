# luci-avahi-web

Independent LuCI application source directory for EasyADB's OpenWrt-side
mDNS experiment. The **source directory** is `luci-avahi-web`; the conventional
OpenWrt **package name** is `luci-app-avahi-web`.

## What is implemented (v0.1.0)

- Services → Avahi / ADB Discovery page, daemon and umdns status.
- Start, stop, restart Avahi; refuse start/restart while `umdns` is running.
- Local browse of `_adb-tls-connect._tcp`, `_adb-tls-pairing._tcp`, or all services.
- IPv4, IPv6, allow-interfaces, reflector, and reflect-ipv configuration.
- Atomic targeted rewrite of `/etc/avahi/avahi-daemon.conf` (preserves other
  settings) with backup at `avahi-daemon.conf.bak-luci-avahi-web`.
- Permission-limited fixed-command helper. No raw arbitrary shell execution.
- Never edits existing EasyADB files or its device database. Never automatically
  shuts down `umdns`, starts Avahi, turns on mDNS reflection, or exposes
  a network listener.

**Scope:** This is a local LuCI discovery dashboard, not yet a NAS registration
agent. An Avahi record is a discovery hint, not proof of ADB connectivity,
pairing, or a reliable mapping from phone LAN IP to its EasyTier route.

## Tested development target / matching the user's router

First target: **ImmortalWrt SNAPSHOT `r0-1f96307`, LuCI Master
`26.223.24468~39dca4a`, Linux `6.18.41`, `qualcommax/ipq60xx`,
JDCloud RE-CS-02**. This dashboard uses modern LuCI JavaScript views and does
not contain native binaries, but its dependencies must come from feeds that
match your exact running firmware.

The overview screenshot does **not** prove whether this SNAPSHOT uses `apk`
or `opkg`. Run the read-only `scripts/check-router.sh` on the router (or
`command -v apk; command -v opkg`) to find out. For an `apk` system, use its
firmware-matched SDK/buildroot to produce a native `.apk`; **do not rename or
force-install the development `.ipk`**. Keep in mind that SNAPSHOT feed indexes
and ABI can change independently of an older flashed firmware.

## Install opkg / IPK firmware (e.g. OpenWrt 24.10)

On an OpenWrt system with matching official feeds:

```sh
opkg update
opkg install luci-base rpcd-mod-file avahi-dbus-daemon avahi-utils
opkg install /tmp/luci-app-avahi-web_0.1.0-1_all.ipk
/etc/init.d/rpcd restart
rm -f /tmp/luci-indexcache
```

Transfer the IPK to `/tmp` first, and refresh the LuCI session. The package
is architecture-independent (`all`) and does not replace upstream Avahi's
package-owned configuration file. The helper **does not automatically start**
Avahi to avoid a silent conflict with existing umdns. Check the status page,
and if you choose to switch daemons, do so explicitly:

```sh
/etc/init.d/umdns stop
/etc/init.d/umdns disable
/etc/init.d/dbus enable
/etc/init.d/dbus start
/etc/init.d/avahi-daemon enable
/etc/init.d/avahi-daemon start
```

For apk-based OpenWrt, use the matching SDK below. Do not rename an IPK to APK.

## Reproducible local IPK build (opkg firmware)

Requires POSIX shell, `ar`, GNU tar, gzip, Node.js and Python for smoke tests:

```sh
sh tests/smoke.sh
# dist/luci-app-avahi-web_0.1.0-1_all.ipk
```

This builds an unsigned **development** IPK with the same root filesystem as
LuCI packaging, without cross-compiling. For a distribution/release package,
use the firmware-matched OpenWrt SDK:

```sh
# From OpenWrt SDK/buildroot root, with LuCI feed installed:
ln -s /path/to/EasyADB/luci-avahi-web package/luci-avahi-web
./scripts/feeds update luci && ./scripts/feeds install luci-base
make menuconfig # select LuCI -> Applications -> luci-app-avahi-web
make package/luci-avahi-web/compile V=s
```

The `Makefile` uses `$(TOPDIR)/feeds/luci/luci.mk` to support independent
sources. SDK outputs the native package format for its firmware (IPK/APK). Use a
matching firmware SDK and its configured feeds, especially for snapshots.

This repository also provides a source ZIP for obtaining the exact package
sources without cloning the whole EasyADB project. An SDK build is not the same
as running `scripts/build-ipk.sh` on a development computer.

## Security and limitations

The LuCI ACL only permits invoking this package's fixed helper commands; the
helper validates exact actions, option count and interface-list characters.
Status/browse require LuCI login, and changes require write permissions.
Reflector stays disabled by default. The page does not touch firewall rules.
Only administer your own router and authorized devices.

On Android 11+, the phone must enable *Wireless debugging*. Traditional
`adb tcpip 5555` need not advertise `_adb-tls-connect._tcp`. mDNS is local
multicast; running Avahi on OpenWrt does not automatically make LAN
multicast visible through EasyTier or send it to the EasyADB NAS.
