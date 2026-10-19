# M3 · OpenWrt 授权发现接入（EasyADB NAS 端）

实现分支：feat/m3-openwrt-discovery。OpenWrt LuCI APK v0.6.0 端保持不变。

## 职责及连接

- 在现有设备「分组设置」中选择性填写私有 IPv4 的 HTTP(S) \`/ubus\`、专用用户名和一次性密钥（例：http://10.10.10.2/ubus）。
- EasyADB 后端调用 RPCD session.login 取得会话，再经 file.exec 执行固定的 \`/usr/libexec/luci-avahi-scan scan\`。不依赖 last ACL，不开新端口、不使用 root 密码、不做轮询、自动连接或自动投屏。
- 只有配置成功的分组才展示「立即发现 ADB」；授权测试需用户明确点击，会真正扫描一次，但不更改设备端口。
- 路由器只保存 /tmp 的最近扫描 JSON，NAS 单独持久化每个分组的最近一次匹配统计。

## 设备地址与端口

数据库原本已有 devices.ip 与 devices.port 两个独立字段，本次保留兼容结构：
\`mesh_ip = ip\`、\`lan_ip = group ip_prefix + mesh_ip 最后八位\`、\`port\` 为两条线路共享的 ADB 端口。
已有 \`temp_ip/temp_port\` 是原来的独立临时连接线路，不被覆盖。
前端将组网/内网 IP 与共用 ADB 端口分开呈现，真正 ADB connect 时才在 selected_address 中生成 serial。

扫描返回的 \`address\` 必须精确匹配当前组内派生的 \`lan_ip\`。不修改组网/内网 IP、设备 ID、临时 IP/端口或其他组设备。未匹配 IP 不新建记录；本次未发现的历史设备保留旧端口。重复端点去重；若同 IP 对应多个扫描端口或多台组内设备，则跳过。更新前检查全库 ADB 地址冲突；冲突单台跳过，不影响其他匹配项。
为避免投屏与已连接 ADB 被静默切换，当前连接中、投屏中或副屏实验未恢复的设备本轮标记 busy 并保留旧端口，下次显式扫描再更新。扫描本身不会调用 adb、不会停止现有投屏。

## NAS 凭据与备份

\`group_openwrt\` 表只存储 Fernet 加密的凭据，API 仅返回 URL、用户名和 \`discovery_configured\`，绝不回传明文或密文。默认密钥位于 \`<EASYADB_DB>.discovery-key\`，首次配置时生成、权限 0600；也可由环境变量 \`EASYADB_DISCOVERY_KEY\` 提供长期密钥。**备份与迁移必须一起保存 DB 和密钥文件**，密钥丢失无法解密以前配置的 OpenWrt 密码，须重新保存凭据。原数据库与原设备 ID 无损迁移。Compose 的 \`./data/storage:/app/data\` 会同时持久化 SQLite 与密钥。

RPCD URL 仅允许私有 IPv4 的 HTTP(S) /ubus，拒绝用户名嵌入 URL、公共 IP、回环、域名、重定向及超大响应，以减少 NAS 后端 SSRF 面。已有 Web 管理入口仍须使用 \`EASYADB_TOKEN\` 鉴权，推荐 EasyTier 内网 HTTPS 与管理端口来源限制。避免在调试日志中打印专用密钥、Fernet key、RPCD session id。

## NAS API

- \`PUT /api/groups/{name}/discovery\`：配置或轮换专用凭据；同 URL/用户名下密码留空保留旧凭据。
- \`DELETE /api/groups/{name}/discovery\`：停用该组 OpenWrt 源，不影响已有设备和原扫描记录。
- \`POST /api/groups/{name}/discovery/test\`：登录并执行一次 scan，验证实际 scan ACL；不持久更新设备。
- \`POST /api/groups/{name}/discovery/scan\`：手动扫描、去重匹配、在一个数据库事务中尝试更新各设备 port，并保存扫描摘要；同组并发扫描返回 409。
- \`GET /api/groups/{name}/discovery/last\`：只读取 NAS 上一次成功扫描的摘要，页面加载不触发扫描。

所有端点都使用现有 \`X-EasyADB-Token\` 保护。后端还区分 HTTP/网络错误、RPCD 登录失败、会话失效/权限不足、扫描执行错误和结构错误。未匹配、冲突、忙碌跳过的设备在结果字段中有独立统计。

## 升级和实机验收

1. 从该分支部署，确保 \`server/requirements.txt\` 中 \`cryptography\` 已安装；不要运行可能切回旧 M2 分支的脚本，部署前设置 \`EASYADB_SOURCE_BRANCH=feat/m3-openwrt-discovery\`。
2. 保留原有 \`./data/storage\` 数据卷；新的组发现相关表在服务启动时无损建立。配置分组的内网 IP 前缀与专用密钥。
3. 明确点击「测试授权」，检查一次扫描 ACL；随后点击该分组「立即发现 ADB」，检查新旧端口、未匹配、端口冲突与 busy 统计。单台设备连接仍需用户主动点击。
4. 实机验证 EasyTier 到 OpenWrt /ubus 的连通性，以及 NAS 到手机内网 IP:新端口的实际路由。**发现成功不等于 ADB 可连接。** 它也不会修复 EasyTier 子网路由、防火墙或安卓无线调试授权。

自动化测试使用模拟 RPCD 与 ADB，不代表已经使用真实路由器账号完成 NAS 联调。
