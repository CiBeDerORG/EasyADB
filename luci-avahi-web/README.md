# luci-avahi-web (v0.5.4)

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

## NAS 接口授权（直接在 LuCI 组件内配置）

LuCI 页面现已内置专用 RPCD 账号管理，无需手工编辑配置文件。
在 **服务 → Avahi / EasyADB 发现代理 → NAS 接口授权** 中，
管理员可以创建账号、轮换凭据、撤销授权，并查看状态。

- 固定用户名：`easyadb`，固定权限组：`luci-avahi-easyadb`；
  仅授予 `/usr/libexec/luci-avahi-scan scan` 的 RPCD `file.exec` 权限。
- 路由器使用 OpenSSL CSPRNG 生成 32 字节（64 位十六进制字符）的随机凭据，
  通过标准输入生成 SHA-512 crypt 哈希，只将哈希存入
  `/etc/config/rpcd`。密码仅在创建/轮换成功响应中展示一次；
  `status` 不返回明文或哈希。
- 创建前检查保留的 `rpcd.easyadb` 段及重名用户，发生冲突绝不覆盖。
  轮换和撤销只操作确认为本组件管理且权限仍精确匹配的账号，
  不改变其他登录项。
- 操作会检查 UCI 待提交修改并加锁，防止交叉覆盖；提交后延迟向
  RPCD 发送 reload，使当前页面有机会展示一次性凭据。
- `openssl-util` 是组件 APK 的必需依赖。创建账号前必须在
  已认证的管理员页面操作；**安装 APK 本身不会创建默认账号或密码**。
- NAS 在 EasyADB 中保存此独立凭据，通过 OpenWrt `/ubus`
  的 `session.login` 获取 Session ID 后请求一次 `scan`。
  不得共享管理员密码、禁用 ubus 鉴权或向公网暴露管理端口。
- 推荐使用 EasyTier 内网访问；如果跨不可信网络，使用 HTTPS 保护
  账号、会话和扫描结果。实机还需验证新账号登录、拒绝越权和轮换失效。

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

## LuCI 中文状态检查（v0.5.4）

管理界面已统一使用中文说明，菜单为「服务 → Avahi / EasyADB 发现代理」。
运行状态区会检测三大组件中每个必需软件包的已安装状态、守护进程可执行文件、
启动脚本、实际进程与开机自启状态，明确区分「安装完整」「部分安装」「未安装」。
Avahi 管理组必须同时具备 `avahi-dbus-daemon` 和 `avahi-utils`；仅有
`avahi-daemon` 进程在运行并不代表已经能用 `avahi-browse` 发现手机端口。

页面改为三张响应式组件卡片，集中展示安装、运行、开机自启以及服务和 APK 操作。
**完全不进行后台定时检测**：首次进入页面读取一次状态，只有点击顶部「手动刷新组件状态」
或安装、启停等操作结束时才回读状态。NAS 最近一次扫描结果也只能手动刷新，
刷新页面状态**不会执行 mDNS 扫描**。相关变更按钮会按当前状态禁用；软件包操作日志折叠显示，
有新操作时自动展开。
如果 Avahi 与 umdns 同时存在运行进程，页面提示存在潜在 mDNS 竞争，
不会把进程共存当作已确诊 UDP 5353 端口冲突，也不会自动停止任一服务。
软件包安装、卸载、更新仍先运行 APK 的模拟事务并由管理员确认。
APK 原生工具输出（版本字符串、软件源警告等）保留原样，页面自己的文案和
后端操作错误提供中文提示。

## v0.5.4 交互审计结果

- 没有任何定时状态检测或页面端 mDNS 扫描。只在进入页面、手动刷新及操作结束时回读状态。
- LuCI 依照 mDNS 守护进程是否运行、是否自启来禁用危险操作。若 Avahi 已安装，
  **只缺 avahi-utils**，允许单独补装工具，不必停止 umdns；真正的 Avahi 守护进程安装及升级仍要求先停止 umdns。
- 启动 Avahi 前会检查 D-Bus 是否运行；开机自启不能同时开启 Avahi 和 umdns。
  对当前已存在的双自启设置仅展示冲突，不自动修改系统服务。
- 软件包模拟结果展示完成后即释放预览锁。取消、Esc、关闭弹窗不会让页面永久处于忙碌状态。
  每个确认弹窗只能提交一次；模拟和实际操作分离，变更后的状态检测失败会给出错误。
- 服务、软件包和账号写操作互斥；NAS 账号创建/轮换/撤销也有专用锁。
  新凭据产生失败时，不会提前清除已显示的一次性凭据。
- 静态模拟及交互测试包含：部分安装、缺工具修复、冲突守护进程、确认取消/重复点击、
  状态读取失败恢复和 RPCD 最小权限边界。真实路由器的 RPCD 登录和服务切换仍需现场验收。

## v0.5.4 实机截图反馈修复

- 修正 APK 3 版本检测。原来的 `apk info -v` 属于 verbose 详细输出，可能将英文软件包描述当成版本，造成 Avahi 卡片撑满整行。现在使用 `apk list --installed --manifest` 严格取指定软件包的版本。
- 前端再次校验版本号格式，格式不正确显示「版本未知」，不显示软件包描述。三张卡片改为独立的响应式容器，不再继承 LuCI `cbi-section` 的特殊排版；包名称支持换行，版本字段宽度受限。
- Avahi 与 umdns 同时运行的说明使用黄色注意提示。仅检测进程共存，不将它直接认定为已发生 UDP 5353 端口冲突。所有启停均需用户主动操作，继续完全取消定时检测。
- 模拟测试新增版本输出污染、三张卡片兄弟节点、响应式容器及无后台轮询的回归场景。

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
`uhttpd-mod-ubus`、`openssl-util`，**不强制依赖三组可选组件**，因此可在空环境中先进入组件管理页面。

## 路由器存储与构建

- 当前仅有一个瞬时结果：`/tmp/luci-avahi-web/last-scan.json`。
  `/tmp` 是 RAM 文件系统，重启清空，避免每次扫描写入 Flash。
- 本应用不额外写入 `/etc/config/` 设备配置。唯一持久化的认证配置是管理员通过此组件授权界面创建的系统原生 `/etc/config/rpcd` 登录项；Avahi 本身维持其原有配置文件。
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
