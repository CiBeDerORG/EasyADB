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
| V2-F02 | P0 | [x] | **定时部署分支白名单**：`scripts/scheduled-deploy.sh` 的 `valid_branch` 和 `read_config` 一致接纳 V2 治理分支及其他明确允许分支；M4、未知分支与非法历史配置明确拒绝；保留原 cron、间隔、锁及增量部署行为。定向测试覆盖启动/状态/到期执行/拒绝。提交 [223f3c2](https://github.com/CiBeDerORG/EasyADB/commit/223f3c28378ef2a1c28f8c30c280bbf41f5a64b7)，[CI #39445004213](https://github.com/CiBeDerORG/EasyADB/actions/runs/39445004213) success。 |
| V2-F03 | P0 | [x] | **构建脚本 WebRTC-only**：`scripts/build-with-mihomo.sh` 在 Git 更新/增量跳过/Docker 前校验配置，缺省 WebRTC、明确拒绝 `mse`、`webcodecs` 和未知值；Mihomo 与 `--no-proxy` 都仅调用现有 `compose.webrtc.yaml`，不改 Compose 内容。模拟测试覆盖两种构建路径、16 种旧/非法配置组合、显式环境变量优先级与 `--if-changed` 拒绝。提交 [f3f1ecc](https://github.com/CiBeDerORG/EasyADB/commit/f3f1ecc05475a9fb7418bd8934eb776e0a0940a7)，[CI #39445961179](https://github.com/CiBeDerORG/EasyADB/actions/runs/39445961179) success。 |
| V2-F04 | P0 | [x] | **统一运行时 Compose**：`compose.yaml`、`compose.no-proxy.yaml` 和脚本正式使用的 `compose.webrtc.yaml` 共用一致 WebRTC host 网络、单 worker 的 Uvicorn 参数数组、绑定地址/端口、鉴权和持久化挂载；无旧 MSE 默认、bridge 运行网络或 8000 端口映射。Mihomo 代理仅作为可选镜像构建参数；模拟部署及三模板一致性回归通过。提交 [3bdaac1](https://github.com/CiBeDerORG/EasyADB/commit/3bdaac14ce1f9bc2bec8af64b08efa6b75e667b6)，[CI #39446650099](https://github.com/CiBeDerORG/EasyADB/actions/runs/39446650099) success。 |
| V2-F05 | P1 | [x] | **启动配额配置端到端贯通**：三份 Compose 均传递 `EASYADB_MAX_STARTING: ${EASYADB_MAX_STARTING:-3}`；独立新进程测试验证未设置默认 3、显式 1/3/5 与 `/api/m2/video-engine` 的返回和预算一致；0/21/负数/非整数拒绝启动，逻辑 Session 上限仍为 20。提交 [45be7f3](https://github.com/CiBeDerORG/EasyADB/commit/45be7f30f42c4013314dcb8080694cf3ce22f185)，[CI #39447296064](https://github.com/CiBeDerORG/EasyADB/actions/runs/39447296064) success。 |
| V2-F06 | P1 | [x] | **Peer 超时后的迟到清理**：`session_cleanup.py` 区分 Worker 错误与 Peer 待确认；Peer 超时不再错误地重置已验证的 Worker `cleanup_complete`，Peer 迟到成功可经 `_close_webrtc_peer` 与 `SessionManager` 将 DIRTY 转为 RELEASED。补完整生命周期测试及 Peer/Worker 失败、未启动 Worker 停止异常、关闭包装异常和旧会话不误释放新会话回归；未验证资源继续保留占位。提交 [d9727d7](https://github.com/CiBeDerORG/EasyADB/commit/d9727d7622c293ce90296a515fa00192303470e7)，[CI #39448241074](https://github.com/CiBeDerORG/EasyADB/actions/runs/39448241074) success。 |
| V2-F07 | P1 | [x] | **视频数据提交背压**：`ScrcpyH264Track.submit()` 在 ADB 线程经锁先预留独立的待调度回调数（48）及载荷字节数（16MiB），再向事件循环提交；超额帧不被回调捕获，并合并无载荷的断帧通知清除旧帧、等待新 IDR。停止立即拒绝新提交，已关闭事件循环仍能完成轨道停止；轨道原有 48 帧/16MiB 队列预算保留。并发高压、超大帧、IDR 恢复、停止竞态、关闭事件循环定向回归均通过。提交 [5a30215](https://github.com/CiBeDerORG/EasyADB/commit/5a3021572419db39faf418615b5622a9b4f619a9)、[f461bf3](https://github.com/CiBeDerORG/EasyADB/commit/f461bf3058a2608a7403d578acc87afd78e0f4a4)，[CI #39449405916](https://github.com/CiBeDerORG/EasyADB/actions/runs/39449405916) success。 |
| V2-F08 | P2 | [x] | **退役 MSE 尾项**：确认当前生产 WebRTC 视频数据不经 WebSocket 二进制路径，删除废弃的 `mux_chunks/media_fragments/mux_idle_ms` 计数及旧视频字节事件；移除 `web/m2-webrtc.js`、`web/m2-metrics.js`、`web/m2-multi.js` 和 JS Mock 的无意义 MSE append/buffer/queue 字段，同时保留有效 WebRTC RTP、解码帧、丢帧和控制诊断。现行 `docs/M2-WEBRTC.md` 已同步 WebRTC-only、20 路逻辑上限、默认启动并发 3 和 Host 网络部署；历史 M2 文档保留。新增旧路径防回退测试。提交 [6bdf3c5](https://github.com/CiBeDerORG/EasyADB/commit/6bdf3c54cded2b6e41ae6764640455b93b1d80e3)，[CI #39450723826](https://github.com/CiBeDerORG/EasyADB/actions/runs/39450723826) success。 |
| V2-F09 | P1 | [ ] | **最终自动化回归与防回退门禁**：核对全套 Python/Node/Shell/OpenWrt 测试覆盖升级、配置、并发、异常释放与 WebRTC-only；在分支最新 HEAD 上 CI 成功，进度文档登记证据。不得用旧提交的绿色 CI 替代。 |
| V2-F10 | 人工验收 | [ ] | **真实环境验收**：按 [V2-ACCEPTANCE.md](V2-ACCEPTANCE.md) 单独执行备份、FNOS/NAS、Android、OpenWrt、EasyTier ICE UDP、1/2/5/10/20 路和长时/异常/回退演练；记录硬件、日志、CPU/RSS、带宽、丢帧与结果。未执行前不称“生产验收通过”。 |

## 当前停点

- **已完成：V2-F01、V2-F02、V2-F03、V2-F04、V2-F05、V2-F06、V2-F07、V2-F08**。
- **下一步只做：V2-F09（最终自动化回归与防回退门禁）**，收到用户明确“继续”后才开始。
- F09～F10 不因前序任务完成而视为已启动或已完成。
- 原 V2-00～V2-07 的历史 CI 通过记录不被此整改清单覆盖；当前发现的问题按上表分别复验。
