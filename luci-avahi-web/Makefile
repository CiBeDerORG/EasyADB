# SPDX-License-Identifier: Apache-2.0
# Independent OpenWrt package, no checked-out feeds/luci/luci.mk required.
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-avahi-web
PKG_VERSION:=0.5.2
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=CiBeDerORG
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-avahi-web
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Avahi/EasyADB NAS-triggered LAN discovery agent
  DEPENDS:=+luci-base +rpcd-mod-file +libubox +uhttpd-mod-ubus +openssl-util
  PKGARCH:=all
endef

define Package/luci-app-avahi-web/description
 LuCI app for a narrowly authenticated NAS-triggered ADB mDNS scan,
 last volatile snapshot, restricted RPCD credential management, and optional Avahi/D-Bus/umdns APK management.
endef

define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/luci-app-avahi-web/install
	$(INSTALL_DIR) $(1)/
	$(CP) ./root/* $(1)/
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
endef

define Package/luci-app-avahi-web/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache.*
	/etc/init.d/rpcd reload >/dev/null 2>&1 || true
}
exit 0
endef

$(eval $(call BuildPackage,luci-app-avahi-web))
