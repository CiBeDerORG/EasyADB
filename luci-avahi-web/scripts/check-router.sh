#!/bin/sh
# Read-only target diagnostics; safe to run on an OpenWrt/ImmortalWrt router.
set -u
printf '%s\n' '== Distribution =='
[ ! -r /etc/openwrt_release ] || cat /etc/openwrt_release
printf '%s\n' '== Kernel and architecture =='
uname -a
printf '%s\n' '== Package manager =='
for cmd in apk opkg; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '%s: %s\n' "$cmd" "$(command -v "$cmd")"
    if [ "$cmd" = apk ]; then apk --version 2>&1 | head -n 1; fi
    if [ "$cmd" = opkg ]; then opkg --version 2>&1 | head -n 1; fi
  fi
done
printf '%s\n' '== Relevant executables =='
for cmd in avahi-daemon avahi-browse dbus-daemon umdns; do
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '%s: %s\n' "$cmd" "$(command -v "$cmd")"
  else
    printf '%s: not installed\n' "$cmd"
  fi
done
printf '%s\n' '== Relevant processes =='
for cmd in avahi-daemon dbus-daemon umdns; do
  if pidof "$cmd" >/dev/null 2>&1; then echo "$cmd: running"; else echo "$cmd: stopped"; fi
done
printf '%s\n' '== Package architecture =='
if command -v apk >/dev/null 2>&1; then apk --print-arch 2>/dev/null || true; fi
if command -v opkg >/dev/null 2>&1; then opkg print-architecture 2>/dev/null || true; fi
