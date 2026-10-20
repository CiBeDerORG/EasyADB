# EasyADB V2 后续优化任务清单

> 建立日期：2026-10-20。工作分支：`refactor/v2-session-governance`。创建时基线 HEAD：`56aa978bf10670eb9a4f56606199f3f32f445183`，对应 [CI #39444098281](https://github.com/CiBeDerORG/EasyADB/actions/runs/39444098281) 已通过。
>
> 这是**后续整改与验收清单**，不是重做 V2-00～V2-07。既有实现与自动化依据见 [V2-PROGRESS.md](V2-PROGRESS.md)，实机项目见 [V2-ACCEPTANCE.md](V2-ACCEPTANCE.md)。

## 执行规则

- **每次用户说“继续”，只执行清单中下一个待处理的最小任务**；独立提交，核对远端 HEAD 和本次 CI，报告后立即停止，不自动展开下一任务。即使 CI 失败，也仅修复当前任务。
- 在当前 `refactor/v2-session-governance` 上快进提交；不自动合并分叉的 `refactor/session-v2`，不碰 main、V1、M3 或 `feat/m4-screen-mapping-m1`。
- 每项必须有定向回归及原有测试，不能将“提交完成”等同于“CI 通过”，也不能将 Mock 等同于真实设备验收。
- 不执行真实 NAS 更新、Docker 部署、定时任务安装、不改用户的 `.env`/SQLite/设备和 OpenWrt 配置；这些仅列入后续人工验收。
- 不能静默回退 FFmpeg + MSE；WebCodecs 只是未实现的预留标识。WebRTC 是 V2 唯一已实现的视频通道。
- 状态更新时登记提交 SHA、Actions 链接与结果。每次只把实际完成的那一项由 `[ ]` 改为 `[x]`。

## 逐项任务（按执行顺序）

| ID | 优先级 | 状态 | 最小任务与验收条件 |
| --- | --- | --- | --- |
| V2-F01 | P0 | [x] | **Git 更新不误切旧分支**：`scripts/update-m2.sh` 识别 V2 治理分支；未知 checkout 明确报错而不切回 M2；定向测试通过。提交 [56aa978](https://github.com/CiBeDerORG/EasyADB/commit/56aa978bf10670eb9a4f56606199f3f32f445183)，[CI #39444098281](https://github.com/CiBeDerORG/EasyADB/actions/runs/39444098281) success。 |
| V2-F02 | P0 | [ ] | **定时部署分支白名单**：仅修改 `scripts/scheduled-deploy.sh` 与对应定向测试，使 `valid_branch`、`read_config` 一致接纳 V2 工作分支；不允许 M4/未知分支，保留 cron、时间间隔、锁、无变更跳过逻辑。 |
| V2-F03 | P0 | [ ] | **构建脚本 WebRTC-only**：`scripts/build-with-mihomo.sh` 未设置引擎时按 WebRTC；遗留 `mse`、未实现的 `webcodecs` 要明确拒绝且不得启动 Docker；保留 Mihomo 与 `--no-proxy` 两条构建方式；加脚本定向回归。 |
| V2-F04 | P0 | [ ] | **统一运行时 Compose**：审查并规范 `compose.yaml`、`compose.no-proxy.yaml`、`compose.webrtc.yaml` 的实际部署入口，避免任何可被误用的 MSE 默认/bridge 视频运行路径；WebRTC 使用 Host 网络与正确 uvicorn 绑定，构建代理路径仍独立；覆盖代理与直连部署模拟，不直接操作真实 Docker。 |
| V2-F05 | P1 | [ ] | **启动配额配置端到端贯通**：实际运行的 Compose 明确传入 `EASYADB_MAX_STARTING`；测试 1/3/5 与无效值，核对服务端 `/api/m2/video-engine` 对应返回；20 个逻辑会话槽位不变。 |
| V2-F06 | P1 | [ ] | **Peer 超时后的迟到清理**：修正 worker 已完成而 peer close 超时导致 `cleanup_complete` 被错误降级、迟到成功也不能释放槽位的状态路径；补 `cleanup_live_session → _close_webrtc_peer → SessionManager` 完整回归。未验证清理、close 异常和旧 Session 回调仍必须 fail-closed。 |
| V2-F07 | P1 | [ ] | **视频数据提交背压**：不仅限制 `ScrcpyH264Track.frames`，还限制 ADB 读取线程经 `call_soon_threadsafe` 提交、尚未进入轨道队列的待处理字节/回调；覆盖持续高负载、停止、丢帧等待 IDR、线程与事件循环竞态，不阻塞事件循环。 |
| V2-F08 | P2 | [ ] | **退役 MSE 尾项**：移除服务端旧 `mux_chunks/media_fragments` 和废弃 WebSocket 视频字节分支（须先确认没有活跃调用）；清理 `web/m2-webrtc.js`、`web/m2-metrics.js`、`web/m2-multi.js`、旧 JS Mock 中无意义的 MSE `append/buffer/queue` 指标；同步修正 `docs/M2-WEBRTC.md` 的旧 MSE 默认、四路上限等过期叙述。保留有效 WebRTC 诊断与历史文档。 |
| V2-F09 | P1 | [ ] | **最终自动化回归与防回退门禁**：核对全套 Python/Node/Shell/OpenWrt 测试覆盖升级、配置、并发、异常释放与 WebRTC-only；在分支最新 HEAD 上 CI 成功，进度文档登记证据。不得用旧提交的绿色 CI 替代。 |
| V2-F10 | 人工验收 | [ ] | **真实环境验收**：按 [V2-ACCEPTANCE.md](V2-ACCEPTANCE.md) 单独执行备份、FNOS/NAS、Android、OpenWrt、EasyTier ICE UDP、1/2/5/10/20 路和长时/异常/回退演练；记录硬件、日志、CPU/RSS、带宽、丢帧与结果。未执行前不称“生产验收通过”。 |

## 当前停点

- **已完成：V2-F01**。
- **下一步只做：V2-F02（定时部署白名单）**，收到用户明确“继续”后才开始。
- F03～F10 不因编写本清单而视为已启动或已完成。
- 原 V2-00～V2-07 的历史 CI 通过记录不被此整改清单覆盖；当前发现的问题按上表分别复验。
