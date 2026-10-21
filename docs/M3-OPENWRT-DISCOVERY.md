# M3 · OpenWrt 授权发现接入（EasyADB NAS 端）

原实现分支：feat/m3-openwrt-discovery；当前部署目标为 `refactor/v4-frontend-standards`，M3 部署脚本及旧 M3 定时配置均迁移到 V4。OpenWrt 需使用 LuCI APK v0.6.1 或以上：NAS 专用 ACL 同时包含 HTTP ubus.file.exec 方法许可及固定扫描脚本的精确执行许可。

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

## NAS 专用凭据

`group_openwrt` 表在原 SQLite 数据库中直接保存从 OpenWrt LuCI 生成并复制的专用密钥；没有第二层加密，没有额外的 `.discovery-key` 文件、主密钥环境变量或文件权限检查。API 只返回接口 URL、用户名及 `discovery_configured`，**不回传专用密钥**。原 `./data/storage` 数据卷继续持久化 SQLite；备份原数据库即可。

从此前 Fernet 加密版本升级时，如果已有旧格式记录，启动时将其标记为 `legacy-fernet`，绝不误用密文登录 RPCD。分组设置提示重新粘贴一次 OpenWrt 专用密钥后保存，即转换为普通存储格式。旧版生成的 `devices.sqlite3.discovery-key` 文件不会再被读取、创建、改动或自动删除，以免误伤尚未迁移的数据。若从未成功保存过旧凭据，直接在分组中输入并保存即可。

保留现有 EasyADB 管理访问密钥 `EASYADB_TOKEN` 和 OpenWrt RPCD 本身的账户鉴权；RPCD URL 仍只允许 RFC1918 IPv4 的 HTTP(S) /ubus，禁止嵌入账号、公共地址、回环、重定向及超大响应，以免 NAS 管理服务被利用发起任意访问。推荐仅在受信任的内网或 EasyTier 中访问 EasyADB，并妥善保管 NAS 数据库。不在运行日志中打印专用密钥和 RPCD 会话标识。

## NAS API

- \`PUT /api/groups/{name}/discovery\`：配置或轮换专用凭据；同 URL/用户名下密码留空保留旧凭据。
- \`DELETE /api/groups/{name}/discovery\`：停用该组 OpenWrt 源，不影响已有设备和原扫描记录。
- \`POST /api/groups/{name}/discovery/test\`：登录并执行一次 scan，验证实际 scan ACL；不持久更新设备。
- \`POST /api/groups/{name}/discovery/scan\`：手动扫描、去重匹配、在一个数据库事务中尝试更新各设备 port，并保存扫描摘要；同组并发扫描返回 409。
- \`GET /api/groups/{name}/discovery/last\`：只读取 NAS 上一次成功扫描的摘要，页面加载不触发扫描。

所有端点都使用现有 \`X-EasyADB-Token\` 保护。后端还区分 HTTP/网络错误、RPCD 登录失败、会话失效/权限不足、扫描执行错误和结构错误。未匹配、冲突、忙碌跳过的设备在结果字段中有独立统计。

## 升级和实机验收

1. 从当前 V4 分支部署，无需独立凭据加密依赖；旧部署脚本需先更新，部署前可显式设置 \`EASYADB_SOURCE_BRANCH=refactor/v4-frontend-standards\`。
2. 保留原有 \`./data/storage\` 数据卷；新的组发现相关表在服务启动时无损建立。配置分组的内网 IP 前缀与专用密钥。
3. 明确点击「测试授权」，检查一次扫描 ACL；随后点击该分组「立即发现 ADB」，检查新旧端口、未匹配、端口冲突与 busy 统计。单台设备连接仍需用户主动点击。
4. 实机验证 EasyTier 到 OpenWrt /ubus 的连通性，以及 NAS 到手机内网 IP:新端口的实际路由。**发现成功不等于 ADB 可连接。** 它也不会修复 EasyTier 子网路由、防火墙或安卓无线调试授权。

自动化测试使用模拟 RPCD 与 ADB，不代表已经使用真实路由器账号完成 NAS 联调。

## v0.6.1 专用 ACL 与 NAS RPCD 错误处理

OpenWrt v0.6.0 的 NAS 专用角色漏配 `read.ubus.file=["exec"]`：`uhttpd-mod-ubus` 会先以 `session.access(object=file,function=exec)` 校验 HTTP ubus 方法权限，即使角色已拥有 `read.file["/usr/libexec/luci-avahi-scan scan"]=["exec"]`，也可能在到达扫描脚本前得到 JSON-RPC `-32002 Access denied`。v0.6.1 补充 `ubus.file.exec`，脚本执行仍仅允许固定命令和 `scan` 参数，其他权限不变。升级 APK 无需轮换专用密码。

EasyADB 不再将 JSON-RPC `error` 统一归为「RPCD 返回协议错误」：按 `session.login`、`file.exec` 区分阶段，报告公开错误码及诊断方向，不记录专用密码、会话令牌或完整原始 RPCD 响应。NAS 与路由器需分别升级后再按组点击「测试授权」及「立即发现 ADB」。

## RPCD 双层 ACL 二次核查

已按 OpenWrt `uhttpd/ubus.c` 和 `rpcd/file.c` 上游流程复核：浏览器、NAS 通过 HTTP `/ubus` 发出 `file.exec` 时，uhttpd 首先调用 `session.access(object=file,function=exec)`，要求 `read.ubus.file=["exec"]`；接下来 rpcd-mod-file 对规范化的固定可执行文件及拼接的参数 `/usr/libexec/luci-avahi-scan scan` 再执行 `session_access(...,"file",...,"exec")`，要求 NAS 角色 `read.file` 只允许这一个命令。v0.6.1 均具备，不能仅因为管理员通过本地 LuCI 扫描成功就认定 NAS 鉴权成功。

EasyADB 的会话重试只针对 HTTP JSON-RPC `-32001 Session not found`，最多重新登录一次。HTTP `-32002` 或 ubus `result:[6]` 明确是权限不足，不得通过反复重新登录掩盖 ACL 问题。单纯的「测试授权」即使没有配置分组的内网 IP 前缀，也允许登录并做一次不入库扫描；只有正式更新设备端口前才需要内网 IP 前缀。测试为模拟 HTTP ubus，最终仍需实机用专用账号验证。

## 多次点击「立即发现 ADB」的 RPCD Session 修复

旧版 NAS 客户端将账号与密码对应的 RPCD Session 缓存在内存中，第二次扫描会直接复用。OpenWrt uhttpd 在执行 `file.exec` 前调用 `session.access`；旧 SID 失效时，检查结果也可能表现为 `-32002 Access denied` 而非 `-32001 Session not found`，从而使“第一次成功、第二次失败”被误诊为静态 ACL 缺失。现在每次**用户主动**点击授权测试或立即发现都独立调用 `session.login`，仅在本次请求内使用 Session；不缓存密码键或 SID，也没有后台扫描。仅本轮显式 `-32001` 可重登一次；重新登录后仍为 `-32002` 则确实需要核对运行时 ACL，绝不放宽授权或盲目重试。
