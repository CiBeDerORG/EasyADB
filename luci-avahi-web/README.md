# luci-avahi-web v0.5.8

ImmortalWrt/OpenWrt 上的轻量 EasyADB 局域网发现代理。仅管理 **Avahi、D-Bus** 两组组件，支持 LuCI 管理员手动发现 Android 无线 ADB 服务，以及 NAS 通过专用 RPCD 会话按需触发扫描。

## 管理界面

菜单：**服务 → Avahi / EasyADB 发现代理**。页面包含两个响应式管理卡片（Avahi、D-Bus）、NAS 接口授权和 ADB 设备发现。

| 组件 | APK 安装目标 |
| --- | --- |
| Avahi | `avahi-dbus-daemon`、`avahi-utils` |
| D-Bus | `dbus` |

软件包管理保留「安装/补齐/更新」合一按钮、卸载确认和 APK 模拟事务/刷新索引；服务控制保留「启动/停止」「启用/关闭自启」切换，按包、运行文件、启动脚本、进程、自启状态显示实际状态。完整安装不展开包名详情；只有缺失才展示明细。D-Bus 仍是 Avahi D-Bus 版本的依赖：停止正在被 Avahi 使用的 D-Bus 会被拒绝。

**本应用不再管理 umdns**：无 umdns 卡片、安装/更新/卸载、启停/自启接口、状态检测，也没有 Avahi 与 umdns 的人为互斥限制。升级本应用**不会卸载、停止或修改路由器已安装的 umdns**。如需管理它，使用 OpenWrt 系统自身工具。

没有后台定时检测或自动 mDNS 扫描。页面初次加载、点击手动刷新或执行变更后才更新组件状态。管理员明确点击「立即发现 ADB」时才扫描；「刷新结果」仅读取最近一次缓存。

## NAS 授权与发现接口

管理员在页面中创建、轮换或撤销固定用户名 `easyadb` 的 RPCD 专用登录。密钥以 OpenSSL 安全随机数生成，只在创建/轮换成功时展示一次；`/etc/config/rpcd` 仅保存密码哈希。安装 APK 不会生成默认密码，已有重名或其他设置冲突不会被覆盖。

- NAS 专用 `luci-avahi-easyadb` ACL **仅**授权 `/usr/libexec/luci-avahi-scan scan`；无软件包管理、服务控制及读取其他系统文件权限。
- 已授权 LuCI 管理员拥有单独的手动 `scan` 和只读 `last` 权限。
- 调用已有 HTTP(S) `/ubus`，经标准 RPCD `session.login` 认证，不开新端口，不提供匿名 API、Webhook 或主动上报。建议仅通过 EasyTier 内网访问并配合管理端口来源限制。
- 每次扫描使用 `avahi-browse -rpt _adb-tls-connect._tcp`，最长 8 秒，最多 32 条已解析端点；并发扫描由锁拒绝。成功 JSON 原子覆盖唯一的 `/tmp/luci-avahi-web/last-scan.json`，重启自动清空，扫描失败保留上次成功快照并返回错误。设备的长期档案由 NAS 的 EasyADB 管理。

登录后请求示意（占位符不是真实凭据）：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "call",
  "params": [
    "<RPCD_SESSION_ID>",
    "file",
    "exec",
    { "command": "/usr/libexec/luci-avahi-scan", "params": ["scan"] }
  ]
}
```

## 构建与测试

主适配对象：ImmortalWrt SNAPSHOT `r0-1f96307`、`qualcommax/ipq60xx`、APK tools 3。构建是独立 `package.mk` 项目，不要求 SDK 预置 `feeds/luci/luci.mk`。应用本体只依赖 `luci-base`、`rpcd-mod-file`、`libubox`、`uhttpd-mod-ubus`、`openssl-util`，不强制将可选 Avahi 或 D-Bus 绑为应用自身的依赖。

在兼容 APK SDK 根目录中执行：
```sh
sh /path/to/luci-avahi-web/scripts/build-apk-sdk.sh /path/to/luci-avahi-web
```

源码模拟测试不能代替路由器实机鉴权、APK 依赖和 mDNS 查询验收。自编译 APK 不等于 IPK，不要改名；在旧 SNAPSHOT 上安装前必须检查模拟依赖事务，不执行系统级 `apk upgrade`。

## v0.5.7：临时目录兼容性与扫描反馈

修复旧版将 `stat -c '%u'` 执行失败误判为“目录不是 root 所有”的错误。在精简 BusyBox 不提供兼容 stat 时，回退读取 `ls -ldn` 数字 UID，并对比扫描进程 UID；继续要求目录属于调用身份、非符号链接、权限 0700，不会使用 chmod 777 或匿名写入。若目录实际归其他 UID 所有，返回可诊断的 UID 差异，仍拒绝不安全操作。

「立即发现 ADB」会在按钮所在区域直接显示运行中、发现端点数量或原始 RPCD 扫描错误，查询失败后自动恢复按钮；不再仅把失败提示放在页面最顶端。没有增加定时轮询、自动扫描、umdns 管理或额外的接口权限。

## v0.5.8：修复 jshn 未定义变量造成的扫描失败

OpenWrt libubox 的 `jshn.sh` 初始化及 JSON 构造会暂时读取未定义的 `JSON_PREFIX`、`JSON_UNSET` 等变量。扫描程序自身通常使用 `set -eu`，此前会使管理员按需扫描在发现阶段之后返回 `JSON_PREFIX: parameter not set`。现只在 JSON 编码段使用 `set +u` 并初始化空 `JSON_PREFIX`，生成 JSON 后立即恢复 `set -u`；`set -e` 与目录安全检查不变。新增模拟测试验证未定义变量条件下成功写入最新快照。
