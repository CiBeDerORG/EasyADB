# luci-avahi-web

Independent LuCI application source directory for EasyADB's OpenWrt-side
mDNS experiment. The **source directory** is `luci-avahi-web`; the conventional
OpenWrt **package name** is `luci-app-avahi-web`.

## What is implemented (v0.2.0)

- Services → Avahi / ADB Discovery page, Avahi/D-Bus/umdns status and
  independent service start/stop/boot enable/disable controls.
- Built-in **APK package management** (Avahi daemon + avahi-utils as one group,
  D-Bus and umdns independently): installed versions, install, uninstall,
  package-scoped update, separately confirmed repository index refresh.
- Each package mutation first shows an `apk --simulate` dependency/transaction
  preview and requires explicit confirmation; package names and operations
  are allowlisted. No bulk `apk upgrade`, forced dependency removal or
  untrusted network-feed installation.
- The LuCI application's required dependencies are only `luci-base` and
  `rpcd-mod-file`; **Avahi, D-Bus and umdns can be absent** while its package
  management page is still usable.
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

This router was subsequently confirmed to use **APK**, not opkg. Use an APK
created by the SDK/buildroot matching its exact ImmortalWrt snapshot. The
standalone development IPK is only for opkg-based firmware; **never rename it
or force-install it as an APK**. A rolling SNAPSHOT feed may have changed since
the installed firmware image was flashed, so compare the actual repositories
and package architecture before installing daemon dependencies.

**The page itself no longer requires you to pre-install Avahi or D-Bus.**
Install this LuCI APK first, then use its package management section. If a
repository is missing or mismatched, the APK dependency solver will report the
error; do not force installation. The UI prevents start/install/update of one
mDNS daemon while the other is running. Stop/disable the old service explicitly
first. D-Bus removal is blocked while its daemon is active and otherwise still
subject to APK dependency resolution.

## APK installation on the actual router (ImmortalWrt SNAPSHOT)

First gather read-only router details:

```sh
apk --version
apk --print-arch
ls -la /etc/apk/repositories.d
cat /etc/apk/repositories.d/*.list
cat /etc/openwrt_release
```

The package itself is architecture-independent and does not require Avahi
or D-Bus to be installed. **Its optional managed packages** must still come
from compatible, trusted firmware feeds. After installing this LuCI APK, use
the page's separate **Refresh package indexes** action, then use **Install**
on Avahi, D-Bus, or umdns as desired. If SNAPSHOT feeds are incompatible,
fix the repository/SDK mismatch rather than forcing installation.

Build the LuCI application with an **exactly matching** firmware SDK that
uses APK. From the SDK root, after installing its matching LuCI feed:

```sh
sh /path/to/luci-avahi-web/scripts/build-apk-sdk.sh /path/to/luci-avahi-web
# The script reports the actual bin/.../luci-app-avahi-web-*.apk filename.
```

Copy that APK to `/tmp` on the router and install your inspected,
self-built local artifact:

```sh
apk add --allow-untrusted /tmp/luci-app-avahi-web-*.apk
/etc/init.d/rpcd restart
rm -f /tmp/luci-indexcache.*
```

A self-built local package uses a signing key not already trusted by this
router; `--allow-untrusted` is only for the specific APK you just built and
inspected, **not** an instruction to disable signatures for network feeds.
The package never starts Avahi or stops umdns during installation. After
installation, go to **Services → Avahi / ADB Discovery**. Review whether umdns
is already running before starting Avahi.

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

For apk-based OpenWrt, use the APK section above. Do not rename an IPK to APK.

## Reproducible local IPK build (opkg firmware)

Requires POSIX shell, `ar`, GNU tar, gzip, Node.js and Python for smoke tests:

```sh
sh tests/smoke.sh
# dist/luci-app-avahi-web_0.2.0-1_all.ipk (opkg-only development build)
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
helper validates exact actions, option count, the three named components and
interface-list characters. Package changes use APK's regular dependency solver
and a simulate-before-confirm flow. Updating an individual SNAPSHOT package is
still a deliberate risk: back up router configuration before performing it.
Status/browse require LuCI login, and changes require write permissions.
Reflector stays disabled by default. The page does not touch firewall rules.
Only administer your own router and authorized devices.

On Android 11+, the phone must enable *Wireless debugging*. Traditional
`adb tcpip 5555` need not advertise `_adb-tls-connect._tcp`. mDNS is local
multicast; running Avahi on OpenWrt does not automatically make LAN
multicast visible through EasyTier or send it to the EasyADB NAS.
