# EasyADB V2 改造进度（正式续接入口）

> 更新时间：2026-10-20。V2 **代码和自动化回归通过**；真实 FNOS/NAS、Android、OpenWrt、EasyTier 网络与多路压测 **未实机验收**。每次后续工作请核对 GitHub HEAD 与最后的 Actions 结果。

## 分支约束和版本迁移

- 本次独立 V2 分支：`refactor/v2-session-governance`，起点为已通过 V1 自动化的 `refactor/foundation-v1` 提交 `cce593021603dfed8feefa904417f49eccd76c8a`。
- 未修改 V1 原分支、M3 原分支、main；严格排除 `feat/m4-screen-mapping-m1` 的画面映射。
- 只保留 WebRTC 视频传输。**原 `FFmpeg + MSE` 已删除，不再是可回退的运行时配置。** 已删除前端 `m2-player.js` 和路由、后端 FFmpeg 子进程/fMP4 包解析/转封装以及 Docker 中的 FFmpeg 依赖。WebCodecs 仅保留不可用的预留标识。
- **部署升级必须将已有 `.env` 的 `EASYADB_VIDEO_ENGINE=mse` 改为 `EASYADB_VIDEO_ENGINE=webrtc`，否则启动参数校验会拒绝启动。** 如未设置该变量则默认 WebRTC。先备份现有 `.env`、SQLite 和部署配置；不清库。
- 不自动连接 ADB、不后台扫描 OpenWrt、不擅自切换设备路线、不自动重开视频 Session；只处理用户显式打开的实时投屏。

## V2 任务分项及真实实现

| 阶段 | 自动化状态 | 落地实现 |
| --- | --- | --- |
| V2-00 移除 FFmpeg + MSE | **已完成、CI 通过** | WebRTC 成为唯一已实现引擎；MSE Python/JS 执行路径和 FFmpeg Docker/CI 依赖去除；废弃播放器和旧 MSE 专属契约测试删除，新增 WebRTC-only 禁回归测试 |
| V2-01 SessionState 状态机 | **已完成、CI 通过** | `server/core/session_state.py`：RESERVED → STARTING → RUNNING → STOPPING → CLEANING → RELEASED 或 DIRTY；状态非法跳转拒绝，DIRTY 不可直接恢复 RUNNING，释放必须提供清理证据 |
| V2-02 SessionManager | **已完成、CI 通过** | `server/services/session_manager.py`：基于已有 LiveRegistry 的唯一槽位所有权和身份；`api/live_handler.py` 真正参与启动、停止、运行、清理及延迟 Peer close，未复制 Session 注册表 |
| V2-03 统一清理 | **已完成、CI 通过** | `server/services/session_cleanup.py`：取消关联任务、停止 Worker、关闭 Peer、限时等待并保留未完成 Peer strong reference；提供 CleanupReport，资源不确定保留占用，异常停止不可提前释放 |
| V2-04 资源预算 | **已完成核心治理、CI 通过** | `server/m2_webrtc.py`：48 个 H.264 待发帧上限 + 单轨累计 16MiB 字节上限 + 256KiB SPS/PPS 配置上限；`server/services/resource_budget.py`：按 LiveRegistry 隔离启动额度，默认 3，可通过 `EASYADB_MAX_STARTING=1..20` 配置；独立于最多 20 路活动 Session；第 21 路被拒绝 |
| V2-05 批量启动调度 | **已完成、CI 通过** | `web/m2-multi.js`：为全批次先登记逻辑目标，最多同时启动服务端返回额度的设备；一个目标就绪/失败后推进下一台；未打开的队列可取消；停止优先，不建立后台重连任务 |
| V2-06 会话诊断和页面 | **已完成、CI 通过** | 会话 diagnostic 携带 `session_phase` 和 `start_budget`，前端每路诊断显示状态与额度；视频统计改为 WebRTC 的入轨帧、解码/丢帧、ICE/DTLS 与接收速率，无原 FFmpeg 假指标；诊断仅随当前活跃 WS 发送 |
| V2-07 自动化验收 | **代码完成，CI 通过** | 状态迁移、并发名额、内存预算、WebRTC SDP、旧回调、脏槽位、清理异常、WebSocket 额度回收、批量上限和 OpenWrt 原烟测；见下方 CI。实机清单另列 |

**重要边界：** 此版本有固定/可配置启动并发预算以及每路视频队列字节预算，**尚未根据真实 NAS 总 CPU、物理 RSS 自动调整视频画质或建立硬件动态准入**。原定动态硬件预算需要 NAS 性能基线支持，不应声称 20 台同时投屏必然流畅。运行时仍可从 ProcessMeter 获取单路 CPU/RSS 诊断。

## 自动化证据

- V1 父提交 `cce5930`：215 passed / 1 warning，作为 V2 回归起点。
- V2 删除 FFmpeg + MSE 与 WebRTC-only 适配、状态机：`c4658a3` 完整 CI [#39438169935](https://github.com/CiBeDerORG/EasyADB/actions/runs/39438169935)，**210 passed**。
- V2-02：`f5f94c1` [#39438508743](https://github.com/CiBeDerORG/EasyADB/actions/runs/39438508743) 成功。
- V2-03：`7576363` [#39438841725](https://github.com/CiBeDerORG/EasyADB/actions/runs/39438841725) 成功。
- V2-04 WebRTC 字节队列与启动预算基础：`19f137b` [#39439041568](https://github.com/CiBeDerORG/EasyADB/actions/runs/39439041568) 成功。
- V2-05 三路启动队列：`9baf2bd` [#39439692345](https://github.com/CiBeDerORG/EasyADB/actions/runs/39439692345) 成功。
- V2-06 服务端额度、会话状态诊断：`48f1654` [#39439863991](https://github.com/CiBeDerORG/EasyADB/actions/runs/39439863991) 成功。
- V2-07 WebSocket 实际名额竞争/停止回收测试发现了“首帧前停止不释放启动配额”的缺陷；已修复于 `9e8a532`，[CI #39440378836](https://github.com/CiBeDerORG/EasyADB/actions/runs/39440378836) **224 passed、1 warning**。前面阶段性失败是代码/测试迁移期间问题，均不计为通过。
- 最终验收仍以本分支最新 HEAD 的 Actions 为准；此文档提交后仍应再次验证。

## 不变的安全约定

1. WebSocket 保留同源握手与第一条 JSON 中的 token，客户端不能提供原始 ADB 命令、PIN 或其他设备的 Session ID。
2. 每设备唯一活动 Session，最多 20 路；一个旧 Session 迟到回调只能释放同一个会话对象身份；清理失败不得靠删除字典项来掩盖。
3. 状态和配额分开：**停止中/清理失败的设备会话可能继续占原 20 路槽位**，但尚未就绪的“启动并发额度”应在会话退出时归还，防止整批任务永久阻塞。
4. 用户选定的 ADB IP/串口及分组不隐式切换；不同设备允许并行，任何错误不得影响另一设备的当前画面与控制。
5. 调试数据仅随用户打开的 WebSocket 存在，不新增后台 ADB 轮询、独立手机探测或自动恢复连接。
6. 不修改已有 SQLite 模型，也不引入 M4 映射分支。

## 真正未完成的验证

请使用 [V2 实机验收清单](V2-ACCEPTANCE.md) 在真实 FNOS/NAS + 安卓 + OpenWrt/EasyTier 环境分别测 1/2/5/10/20 路、长时/失联/脏会话/CPU-RSS/ICE UDP。未做实机验证前，不表示 V2 生产部署已验收；回退应从独立 V1 分支部署，并恢复相应的引擎配置。
