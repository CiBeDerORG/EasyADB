# luci-avahi-web (v0.4.0)

ImmortalWrt/OpenWrt 的轻量 EasyADB 局域网发现代理。仅保留 **NAS 主动触发扫描**、
**OpenWrt 最近一次成功扫描快照**、以及 **Avahi / D-Bus / umdns 三组 APK 组件管理**。

项目目录：`luci-avahi-web/`，安装包名称：`luci-app-avahi-web`。

## 精简后的运行边界

- **只有经过 RPCD 登录、且被单独授予 `luci-avahi-easyadb` ACL 的 NAS 会话**，
  才能通过 OpenWrt 现有 `/ubus` 的 `file.exec` 调用扫描命令。没有匿名入口、独立
  HTTP 服务、Webhook、自动上报、后台定时扫描。
- LuCI 页面**不能发起扫描**，只展示最近一次成功结果、软件包及守护进程状态；
  页面刷新不触发 mDNS 查询。
- `/usr/libexec/luci-avahi-scan scan` 每次执行一次
  `_adb-tls-connect._tcp` 查询，最多 8 秒、32 个解析后端点；单实例锁防止并发。
  接口即时返回 JSON，成功结果原子覆盖 `/tmp/luci-avahi-web/last-scan.json`。
- `/usr/libexec/luci-avahi-scan last` 只读取该快照；路由器重启后数据消失。
  **不存在**设备列表数据库、历史事件文件和额外 log API。扫描失败以命令错误返回，
  不会把上次快照冒充本次结果；上次成功快照仍标有旧的 `scanned_at`。
- NAS/EasyADB 自己保存正式设备档案、历史连接与 IP/端口映射。广告不是设备身份，
  也不是 ADB 已成功配对/连接的证明。传统 `adb tcpip 5555` 不一定发布 TLS mDNS。
- Avahi 高级编辑、反射器配置及本地手动查询功能已从此应用移除；
  如有其他需要，可使用系统提供的 Avahi 配置文件/工具单独维护。

## NAS 接口鉴权（必须完成部署后才能使用）

本应用只安装**固定的 RPCD ACL 角色**，绝不自动生成默认密码、匿名账号，
也不会给 NAS 开放 LuCI 管理权限。

OpenWrt 原生 RPCD 在 `/etc/config/rpcd` 中使用 `config login` 和
`list read` 配置登录及授权。管理员需要**单独配置**专用登录，并使用已验证可被
路由器 `crypt(3)` 识别的高强度密码哈希，例如：

```sh
# 以下为说明模板；不要原样使用尖括号占位符作为实际密码哈希。
uci set rpcd.easyadb=login
uci set rpcd.easyadb.username='easyadb'
uci set rpcd.easyadb.password='<SUPPORTED_PASSWORD_HASH>'
uci -q delete rpcd.easyadb.read
uci add_list rpcd.easyadb.read='luci-avahi-easyadb'
uci -q delete rpcd.easyadb.write
uci commit rpcd
/etc/init.d/rpcd restart
```

先通过 `/ubus` 的 `session.login` 登录获取会话 ID，并核验该会话仅拥有
`luci-avahi-easyadb` 权限；不能使用 LuCI root 管理员凭据来代替。建议仅允许 NAS
EasyTier IP 经防火墙到达路由器的管理端口，必要时由 HTTPS 提供额外传输保护。
不得为省事关闭 UBUS 鉴权或向公网放开管理端口。

**接口请求示意**（不是现成凭据）：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "call",
  "params": [
    "<AUTHENTICATED_RPCD_SESSION>",
    "file",
    "exec",
    {
      "command": "/usr/libexec/luci-avahi-scan",
      "params": ["scan"]
    }
  ]
}
```

POST 到路由器现有 `/ubus`，并检查 UBUS 状态和 `file.exec.code`；
仅当后者为零时，将 `stdout` 解析为 JSON：

```json
{
  "status": "ok",
  "source": "avahi",
  "scanned_at": 1792400000,
  "devices": [
    {
      "iface": "br-lan",
      "protocol": "IPv4",
      "instance": "adb-example",
      "service": "_adb-tls-connect._tcp",
      "host": "android.local",
      "address": "192.168.1.101",
      "port": 38711
    }
  ],
  "count": 1,
  "storage": "volatile"
}
```

`last` 仅供已授权的 LuCI 管理员读取页面快照，不授予 NAS 专用角色；
NAS 要获取新的设备端口就执行一次 `scan`。

## APK 组件管理

| 分组 | 用户请求安装的软件包 |
|---|---|
| Avahi | `avahi-dbus-daemon` + `avahi-utils` |
| D-Bus | `dbus` |
| umdns | `umdns` |

三组分别支持**安装、卸载、按组件更新**及软件源索引刷新。
由系统 APK 正常递归解析所有传递依赖，不在此应用中硬编码依赖清单。
每次包变更先执行 `apk --simulate` 并由管理员确认；禁止任意软件包名、
强制卸载及全系统 `apk upgrade`。安装 Avahi 前如果 umdns 正在运行会明确要求先停用，
反之亦然。LuCI 保留 Avahi/umdns 的必要启停和开机管理、以及 D-Bus 启动。

应用自身仅依赖 `luci-base`、`rpcd-mod-file`、`libubox`、
`uhttpd-mod-ubus`，**不强制依赖三组可选组件**，因此可在空环境中先进入组件管理页面。

## 路由器存储与构建

- 当前仅有一个瞬时结果：`/tmp/luci-avahi-web/last-scan.json`。
  `/tmp` 是 RAM 文件系统，重启清空，避免每次扫描写入 Flash。
- 本应用不额外写入 `/etc/config/` 设备配置。唯一持久化的认证配置是管理员手动
  添加的系统原生 `/etc/config/rpcd` 登录项；Avahi 本身维持其原有配置文件。
- 主适配对象：ImmortalWrt SNAPSHOT `r0-1f96307`，
  `qualcommax/ipq60xx`，用户设备上 `apk-tools 3.0.5`。
- `Makefile` 直接使用 `$(INCLUDE_DIR)/package.mk` 封装 LuCI 菜单、静态页面、ACL
  和固定后端脚本，不再依赖公开 SDK 里未必存在的 `feeds/luci/luci.mk`。
- 与路由器匹配的原生 APK 须通过 SDK 生成；**IPK 不兼容 APK，不能改名使用**。
  同时不建议在已安装的旧 SNAPSHOT 上进行系统级滚动升级。

在匹配固件的 APK SDK 根目录运行：

```sh
sh /path/to/luci-avahi-web/scripts/build-apk-sdk.sh /path/to/luci-avahi-web
```

验证从 CI 构建获取的原生 APK、检查其依赖后，再在真实路由器做安装和权限验收。
本仓库的静态模拟测试不等于实机安全验收。
