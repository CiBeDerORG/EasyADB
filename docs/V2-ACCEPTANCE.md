# V2 实机与压力验收（自动化之外）

> 当前以下人工项目全部 **待执行**，不是已经通过。代码分支：`refactor/v2-session-governance`；不得使用 M4 映射分支替代。

## 自动化已验证

- [x] WebRTC-only 环境默认和 MSE 显式拒绝；废弃 MSE JS 路由、Docker 的 FFmpeg 依赖、fMP4 代码移除。
- [x] Python Mock/WS/Node/Shell/OpenWrt 模拟回归通过（详细 CI 见 [进度文档](V2-PROGRESS.md)）。
- [x] 20 路逻辑槽位/第 21 路拒绝，脏 Session 不复用，旧 Session 回调不释放新 Session。
- [x] 会话状态非法跳转拒绝、启动失败停止与 Peer 关闭超时保留未确认清理状态。
- [x] WebRTC 包队列字节上限、不同设备独立并发、首帧前停止退回启动额度。

## 人工部署和视频链路

- [ ] **备份并升级**：备份现有 SQLite、分组发现凭据、开屏密码数据、`.env` 与 Docker Compose；将 `EASYADB_VIDEO_ENGINE=mse` 更新为 `webrtc`（或删掉该项，默认 webrtc）；保持原 SQLite，不清库。
- [ ] **手动连接/视频**：分别在 1 台、2 台 Mate30/其他安卓设备上显式配对和连接，再手动启动/停止 WebRTC 投屏，检查首帧、H.264、触控、锁屏和副屏实验原能力。
- [ ] **FNOS+EasyTier UDP 路径**：检查 NAS 与浏览器间 ICE UDP 可达、WebRTC SDP Offer/Answer/H264、不同网络下的黑屏和断线错误提示；不得依赖已删除的 FFmpeg。
- [ ] **批量队列**：使用 `EASYADB_MAX_STARTING=3`，选择多台设备，核对先启动最多三路，其余排队；完成/失败继续下批；取消排队项和批量停止不会影响其他活跃 Session。
- [ ] **上限与环境配置**：分别测试 `EASYADB_MAX_STARTING=1` 与 `=5`，确认浏览器从服务端读取同一额度；逻辑 Session 仍最多 20 路，第 21 路应明确拒绝。
- [ ] **异常清理**：关闭浏览器标签、断网、手机重启、ADB 掉线、WebRTC Peer 关闭卡住、设备选定 IP 改变等情况下，检查关闭、错误原因、脏槽位是否保留；禁止强行释放不确定资源。
- [ ] **原 M3 功能**：复验 OpenWrt RPCD 手动发现、内网 IP/端口更新、组修改、状态查询、授权/鉴权；V2 不应触发隐藏 OpenWrt 扫描或重连。
- [ ] **逐级负载与长期运行**：从 1 → 2 → 5 → 10 → 20 路，记录 CPU / RSS / 带宽 / H264 编码帧 / 丢帧 / WebRTC 网络状态和停止清理时间；20 是软件会话上限，不是已实测的 NAS 吞吐保证。
- [ ] **回退**：执行预演，将容器运行代码退回独立的 `refactor/foundation-v1`，确保 DB 未损坏；按 V1 引擎配置单独恢复，不能在 V2 仍设置 `mse`。

报告应逐项填写执行者、日期、NAS/路由器/手机型号、系统版本、步骤、实际现象和日志。真实设备测试不得以 Python Mock 自动勾选。
