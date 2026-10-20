# EasyADB V2 开发顺序与进度

**唯一工作分支：** `refactor/session-v2`，从已通过自动化验收的 V1 `cce593021603dfed8feefa904417f49eccd76c8a` 创建；严格排除 M4 映射分支。本文记录代码与 CI；真实 NAS / 安卓 / OpenWrt 验证单列。

## V2 范围（先移除旧链路，再依次实施）

| 阶段 | 内容 | 验收判定 |
| --- | --- | --- |
| V2-00 | **彻底移除 FFmpeg + MSE**，仅保留 scrcpy H.264 → aiortc WebRTC 视频。清除 Worker/fMP4、前端播放器、FFmpeg 镜像依赖及旧媒体测试；WebRTC 使用 Linux host networking，旧 `.env` 的 `mse` 必须明确报错 | CI 全绿；只有 WebRTC 的连接协议/静态资源/实际镜像拓扑 |
| V2-01 | 纯会话状态机：RESERVED → STARTING → RUNNING → STOPPING → CLEANING → RELEASED；未证实清理时 DIRTY | 状态迁移表、重复/非法转换、多线程测试 |
| V2-02 | SessionManager 统一会话创建、所有权和停止协调；底层 LiveVideo 继续专司视频/控制 | 一个逻辑设备一个会话，迟到回调不能释放新会话，跨设备不互锁 |
| V2-03 | CleanupCoordinator 分项核验线程、ADB 转发、临时 jar/socket、WebRTC Peer，安全处理半开连接和超时 | 脏会话保持占用，晚到清理完成后有证据地释放，停止幂等 |
| V2-04 | 资源预算：保留最多 20 会话，独立启动并发、WebRTC 队列字节数、进程采样和容量准入 | 第 21 路、溢出、资源回收与性能测试 |
| V2-05 | 批量队列与优先停止，独立反馈每台设备的进度；不影响未选中的正在运行会话 | 双设备并行、异常隔离、队列取消、停止优先 |
| V2-06 | 会话/全局诊断和前端真实状态；只沿已有活动 WS 发送，不增后台 ADB 探测 | 不新增无页面时的 NAS ↔ 手机通信 |
| V2-07 | 完整 Python/Node/Shell/浏览器信令与 OpenWrt Mock 回归；列出真实多设备验收 | CI 成功和实机待办明确分列 |

## 当前停点（本轮仅 V2-00）

V2-00 的主要删除与 WebRTC-only 替换已提交于本分支，并在提交 `a896d39` 的 [Actions #39426683280](https://github.com/CiBeDerORG/EasyADB/actions/runs/39426683280) 通过。此轮复核进一步删除旧 MSE 的伪诊断字段/播放器空方法，修复定时部署脚本对本分支的拒绝，并新增相应回归。**只在本轮新增 HEAD 的 CI 再次通过后将清理收尾标为自动化通过。** 不等于真实 NAS / 安卓 / ICE 网络实机验收或生产部署许可。

用户已明确要求先单独完成 FFmpeg + MSE 移除，**V2-01～V2-07 暂停执行**。另一分支 `refactor/v2-session-governance` 上已存在独立提交，本轮不合并、不覆盖、不追加，也不修改 V1、M3、main、M4。已有设备 SQLite、开屏密码和原有 WebSocket 鉴权继续保留。

## 不改变的安全契约

- 不自动连接 ADB、自动投屏、隐式扫描、自动重连或无页面常驻轮询。
- 设备 ID / 选中线路 / Session ID 不得交叉，原 SQL 数据与开屏密码不迁移。
- 只允许单个被鉴权的 WebSocket 启动一条明确选中的 WebRTC 流，视频走 ICE/DTLS-SRTP，WS 只交换限定的信令、诊断和控制。
- 未经清理核验不得释放/复用 Session，20 是名额上限而非真机 20 路性能承诺。
- M3 和 V1 原分支不做本轮修改；没有 M4 画面映射。
