# SPDX-License-Identifier: Apache-2.0
include $(TOPDIR)/rules.mk

LUCI_NAME:=luci-app-avahi-web
LUCI_TITLE:=Avahi mDNS and Android wireless ADB discovery dashboard
LUCI_DEPENDS:=+luci-base +rpcd-mod-file +libubox +uhttpd-mod-ubus
LUCI_PKGARCH:=all
PKG_VERSION:=0.3.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

# This source package may live in package/luci-avahi-web instead of feeds/luci.
include $(TOPDIR)/feeds/luci/luci.mk
