# EasyADB V4 · 当前任务与验收清单

> 工作分支：`refactor/v4-frontend-standards`。当前状态以本文件顶部为准；历史实现、失败与验收记录见 [V4-PROGRESS.md](V4-PROGRESS.md)，开发规范见 [V4-FRONTEND-STANDARDS.md](V4-FRONTEND-STANDARDS.md)。

## Agent 接续摘要

更新时间：2026-10-21。本轮从干净的 `6e6f96be7a5cece6963e3ba02be88686a5e1a331` 接续，核对了三份文档、远端分支与工作区，仅处理用户反馈的横竖屏切换退出问题。

| 项目 | 当前交接状态 |
| --- | --- |
| 仓库与分支 | `CiBeDerORG/EasyADB` / `refactor/v4-frontend-standards` |
| 原有进度 | V4-01～V4-05、M3 部署入口迁移、记录修改保护、此前 9 项 BUG 修复、最新页面接管及浮窗收窄已完成；本轮保留既有成果 |
| 本轮实现 | **1/1 完成（代码与自动化验收）**：正常横竖屏切换在原会话内继续投屏，更新画面比例与触控尺寸 |
| 代码提交 | [21454e6](https://github.com/CiBeDerORG/EasyADB/commit/21454e62ef36aa5008c580f53be1e9debb4e7c6b)；本项定向验收及交叉复核后立即 push，使用 `[skip ci]` |
| 统一 CI | `fd58a1be46105929072891bbe8bc50adf73cfa82` 仅触发验收，与修复提交代码树相同；[CI #39608125557](https://github.com/CiBeDerORG/EasyADB/actions/runs/39608125557) **success：448 项 Python，通过全部适用门禁** |
| 文档交接 | 实际 CI 结果已记录；三份文档以 `[skip ci]` 发布，与验收提交仅有文档差异，文档 HEAD 未另跑 CI |
| 未验证 | 未连接真机或取得 logcat，不能确认或排除 Android App 进程本身崩溃；真实浏览器、Android、FNOS/NAS/Docker、OpenWrt/EasyTier 部署及实机旋转表现仍待验证 |

以上 SHA 是交接快照，不是要求回退到固定版本。后续继续前读取远端最新 HEAD 与工作区，保留已有改动，不覆盖他人提交、不重复完成项。

## 执行规则

- **全局约定：每完成一项独立改动，按下列规则复核后立即提交并 push。**
- **用户最新补充：简单改动不运行自动化测试，不触发 GitHub Actions。** 文档、提示文案、样式微调及明确不改变业务逻辑的局部调整，只人工核对变更内容和 Git 状态；提交使用 `[skip ci]`，不另建 CI 触发提交，也不为此补跑整套验收。
- 涉及会话、协议、并发、持久化、鉴权、部署流程等行为变化时，按实际影响安排对应回归；不能仅凭改动行数少认定为简单改动。复杂或有行为影响的批量 BUG 修复，连续完成当前已授权清单，各项完成立即 push，中间提交使用 `[skip ci]`，全部代码完成后统一触发一次完整 CI；不逐项停止等待“继续”。
- 完成后更新本清单与进度，区分代码已实现、测试通过和未验证。简单改动明确记录“按用户规则未运行测试/CI”，不能把未运行写成通过；需要 CI 的批次记录实际验收结果，最终文档提交使用 `[skip ci]` 并核对仅文档差异。保留现有测试和工作流，后续变更继续按本节判断。
- 既有 REST/WS 字段继续兼容；本轮新增同会话 `resize` 通知，保留此前的接管通知与等待语义。保留数据库结构、SessionManager 的唯一清理权威、DIRTY 保护、20 路逻辑上限和 WebRTC-only。按故障需要调整内部实现，不以回避改动替代修复。
- 遵循 [前端命名与架构规范](V4-FRONTEND-STANDARDS.md)，测试执行生产路径，禁止删除断言、放宽保护或修改生产常量来制造通过。
- 本轮授权是代码修复、测试、提交与推送；不执行真实设备、Docker、cron 或 NAS 部署，不合并其他开发分支。V3 继续暂缓。

## 本轮 BUG 清单（2026-10-21）

| 用户反馈 | 状态 | 已确认原因与修复结果 | 已推送提交 |
| --- | --- | --- | --- |
| 横屏转竖屏、竖屏转横屏时退出 | [x] | 旧 live reader 将 scrcpy 正常 session/尺寸通知直接当异常终止。现在原会话处理新尺寸，清除旧编码配置和积压，等待新 config + IDR 后继续；独立 resize 更新布局与触控，不重建播放器、不重复 init/自动解锁。 | [21454e6](https://github.com/CiBeDerORG/EasyADB/commit/21454e62ef36aa5008c580f53be1e9debb4e7c6b) |

新增 **34 项 Python 回归**：17 项真实媒体头解析、15 项媒体轨道/资源/真实 H.264 编解码、2 项 handler 会话与接管隔离。前端沿原入口运行真实页面、MultiView、TouchController，覆盖双向旋转、媒体与通知两种先后、旧手势取消、错误 SID、停止及旧回调。相关本地 154 项 Python 通过；完整 CI 为 **448 passed, 1 warning**。

本轮修复的是已定位的 EasyADB 投屏退出路径。真实 H.264 回归通过同一个解码器处理 96×160 → 160×96 → 96×160 的六帧，只证明媒体代码路径；没有据此把 Android App 进程闪退写为已确认或已实机修复。

## 上轮需求清单（2026-10-21，已完成）

| 用户需求 | 状态 | 完成结果 | 已推送提交 |
| --- | --- | --- | --- |
| 最新页面取得同一设备的实时画面 | [x] | 最新有效显式请求撤销旧页面的画面和控制，旧页面提示已接管并清除重连意图；旧资源未清理时沿同一 WebSocket 等待；清理确认、设备复验及容量/启动预算允许后自动继续启动。连续三个页面只允许最后一个有效请求继续；无效请求不抢占，等待时退出不迟到启动。 | [0cb5101](https://github.com/CiBeDerORG/EasyADB/commit/0cb5101d982817581c566293a7e25fed10e1ad43) |
| 设备浮窗整体稍微收窄 | [x] | `.inventory-drawer` 最大宽度从 900px 调整为 760px，仍使用 `min(760px, calc(100vw - 62px))`，保留窄屏边距与原展开、收起、全屏行为。 | [8325ee3](https://github.com/CiBeDerORG/EasyADB/commit/8325ee3e8c085579ddd75ad33164c2db6d45b4bd) |

接管只由显式投屏请求触发，单纯打开网页不主动连接设备或启动视频。旧资源未清理时不能重叠启动；清理等待超时返回 `takeover_timeout`，保留原 DIRTY 所有权。`replaced` 不是 `ended(cleanup_complete=true)`，批量停止仍如实计为清理未确认。其他设备、20 路逻辑容量及启动预算保持原有约束。

当时新增 22 项真实 handler 接管回归和 19 项请求协调回归；前端通过既有真实页面/四个 live 工厂测试入口新增接管场景。对应 CI #39575926695 success、414 项 Python 通过；本轮继续保留这些功能与回归。历史验收细节见进度文档，自动化验收不等于实机验收。

## 一、V4 总体进度

状态说明：`[x]` = 对应代码与自动化验收完成；`[~]` = 进行中；`[ ]` = 未开始或待处理。自动化通过不等于实机验收通过。

| ID | 优先级 | 状态 | 最小交付与验收 |
| --- | --- | --- | --- |
| V4-01 | P0 | [x] | **前端架构、命名及代码规范门禁**：新增 `V4-FRONTEND-STANDARDS.md`、EditorConfig、ESLint、Prettier、锁定 npm 依赖及 Node 架构测试；增量约束新模块的目录/文件命名、camelCase、禁止新增 window 全局业务导出。旧七份 IIFE 和 `index.html` 显式豁免，不批量格式化；`node_modules/` 从 Git/Docker 构建上下文排除。V4 CI 独立执行 `npm ci`、lint、format 和命名门禁，原 Python/Node/Shell/OpenWrt 回归继续运行。最终代码提交 [3548925](https://github.com/CiBeDerORG/EasyADB/commit/3548925e1fe0343ff86cd255a7a643e335fdc061)，[CI #39456125975](https://github.com/CiBeDerORG/EasyADB/actions/runs/39456125975) success；未修改原业务脚本。 |
| V4-02 | P0 | [x] | **公共 ES Modules 抽离**：新增 API Client、DOM、Toast、Dialog 模块及 `app/main.js` 一次性装配；原页面通过兼容适配层使用，无新增 window 业务全局。Toast 键值替换、计时、旧回调隔离，Dialog 焦点和表单校验仍兼容。静态服务新增五个精确 GET 资源白名单、不开放通配目录；补 Node 模块行为、HTTP 白名单、原页面契约测试。最终代码 [485ecc3](https://github.com/CiBeDerORG/EasyADB/commit/485ecc34c90929c4e290cb2fd34fde46074d55dc)，[CI #39458266192](https://github.com/CiBeDerORG/EasyADB/actions/runs/39458266192) success；未改 V2 SessionManager/DB/协议。 |
| V4-03 | P0 | [x] | **单路 LiveSessionController 资源所有权**：新增 `web/features/live/live-session-controller.js`，由 V4-02 的一次性 ES Module 装配注入生产 `MultiView`；每台设备本轮独占 WS、WebRTC Player、Touch、Meter/QualityMeter、sessionId、帧回调及停止计时器。卡片旧字段仅为兼容访问器，服务端 SessionManager 仍为清理与槽位释放权威。回调核对当前卡片/Socket，Session ID 不允许被另一个值覆盖，迟到结束/错误/停止超时不能影响替代会话；仅服务端确认清理后允许显式一次性重连。保留原多画面、群控、20 路及页面接口，旧 Node VM fixture 已注入真实新控制器执行集成回归；新增独立生命周期/诊断隔离测试和精确静态资源白名单。最终代码 [a205512](https://github.com/CiBeDerORG/EasyADB/commit/a2055120185c823bcc6065ddabc372221ee70d9a)，[CI #39461806736](https://github.com/CiBeDerORG/EasyADB/actions/runs/39461806736) success。真实环境验收仍待 V2-F10。 |
| V4-04 | P0 | [x] | **MultiView 职责拆分**：新增 `features/live/live-batch-scheduler.js`（启动队列、批量代次、并发预算与完成回调）、`live-card-view.js`（画面容器、宽高自适应、会话诊断与悬浮日志 DOM）、`live-quality-settings.js`（设备画质 Map、wire payload、实验性分辨率及参数弹窗），通过 `app/main.js` 单次 ES Module 装配注入。首次使用懒装配，继承页面已有画质选项与服务器下发 `max_starting`；保留原字段兼容代理及旧 VM 回退，供 V4-05 逐项清理。新增三个精确静态 JS 白名单；旧多画面/20 路 Node 契约已注入真实三个模块，增强了先建页面后装配的数据保留回归。最终代码 [5335af0](https://github.com/CiBeDerORG/EasyADB/commit/5335af034b039346994c6495706d2500e9875a01)，[CI #39464539417](https://github.com/CiBeDerORG/EasyADB/actions/runs/39464539417) success。 |
| V4-05 | P1 | [x] | **设备管理及页面 JS/CSS 模块化**：A/B/C/D1/D2/D3/E/F 均完成。F 删除页面及 MultiView 已替代的重复实现，直接装配唯一模块；迁移原 VM/源码位置契约，保留共享设备/选择、五个 dialog、原交互及 20 路行为，收紧格式/lint 豁免。最终代码 [44aad3b](https://github.com/CiBeDerORG/EasyADB/commit/44aad3bb522f784b7a09a2037c5b67cdabc485ab)，[CI #39557844420](https://github.com/CiBeDerORG/EasyADB/actions/runs/39557844420) success；真实环境验收仍待执行。 |

## 部署补充：M3 入口迁移至 V4（已完成，2026-10-21）

本项来自用户在分支核查后的明确要求；以下保留当时的部署验收记录，当前 BUG 状态见下方清单。

- **V4 更新支持**：`scripts/update-m2.sh` 接受当前或显式 V4，将旧 M3 来源及 detached HEAD 的空来源解析为 V4；其他已支持的历史分支仍保留显式选择。`scheduled-deploy.sh` 的启动、状态和到期执行一致支持 V4，旧 M3 保存配置继续按 V4 执行。
- **M3 迁移入口**：M3 分支的更新脚本将所有接受的来源名称解析为 V4，使用显式 refspec 获取目标、切换后只对 V4 执行 `pull --ff-only`。构建入口处理旧脚本自更新后传来的 `EASYADB_UPDATED=1`，同一次调用继续迁移并执行 V4 构建，保留默认 Mihomo、`--no-proxy` 和 `--if-changed`。旧 M3 定时任务首次到期后迁移，下一轮仍保持 V4。
- **Git 与数据保护**：新建本地 V4 使用 `--no-track`，适用于只克隆 M3 的仓库，不改写 `origin.fetch`。保持原登录用户的 Git 身份、脏工作区拒绝和快进保护；不强制重置、不合并两支历史。既有 `.env`、设备数据、ADB 授权与缓存保留；失败构建不前移成功部署标记。
- **实际验收**：V4 代码 `18ce0f0` 的 CI #39562752144 success，**304 项 Python**、原有 21 个 Node/UI 入口、4 个架构/模块入口、lint/format、Shell/OpenWrt 全部适用步骤通过；V2 专用 release 步骤按分支条件 skipped，全量 pytest 保留 V2 回归。M3 代码 `396bbcd` 的 CI #39563091403 success，**228 项 Python**、原 Node/UI、Shell/OpenWrt 与旧 MSE 回归继续通过，未删除旧业务门禁。
- **本地定向证据**：V4 46 项更新/定时测试和 24 项既有部署模式测试通过；M3 39 项部署/迁移/定时测试通过，另有 12 份 Shell 语法检查。M3 测试从 `5ff047f` 原脚本启动，使用真实本地 Git 分叉历史和假 Docker/cron，检查两次更新、单分支克隆、原始参数、数据保留、旧引擎拒绝、失败重试和连续调度；V4 脚本快照与已发布 `18ce0f0` 逐字一致。
- **配置与未验证边界**：V4 只实现 WebRTC，显式旧 `mse`/`webcodecs` 配置需由用户改为 `webrtc`；拒绝时可能已切换 Git，但尚未执行 Docker。host 网络及 ICE 动态 UDP 的真实环境适配未验收。自动兼容指旧 M3 保存配置；另存 M2/display-lab 的定时配置在手动迁移后须重新保存 V4 目标，详见 README。未执行真实 NAS/FNOS、浏览器、Android、OpenWrt/EasyTier 部署与设备验收。


## 上轮 BUG 修复清单（2026-10-21，已完成）

上轮以下 9 项代码均已完成、立即推送，并通过整批统一 CI；`[x]` 表示代码与自动化验收完成，不代表实机验收。原先已修复的记录修改保护单列为既有成果。

| 问题 | 状态 | 修复结果 | 已推送提交 |
| --- | --- | --- | --- |
| 投屏启动阻塞事件循环 | [x] | 同步设备锁、扫描、数据库读取移至工作线程；同一设备锁内复核地址后预留。补齐取消时取得准入结果和完成清理报告的所有权。 | [4b53b9c](https://github.com/CiBeDerORG/EasyADB/commit/4b53b9ced48d8b36fd7f017c8f429bc7346f4482)、[464a493](https://github.com/CiBeDerORG/EasyADB/commit/464a493966f64549e5517f62b5792ca0783d9ae4) |
| 迟到 worker 清理不归还槽位 | [x] | worker 完成后通知既有 SessionManager；核对 worker、ADB/scrcpy 与 peer 清理证明，并保留精确会话身份检查。 | [be4bac5](https://github.com/CiBeDerORG/EasyADB/commit/be4bac5a456f12e42b3d9f47938275e84cf0e1cc) |
| 副屏实验阻塞无关设备管理 | [x] | Overlay/Cast 的 ADB 等待按设备串行；共享锁只保护状态、原子持久化和日志，失败只回滚当前设备记录。 | [bea7ea1](https://github.com/CiBeDerORG/EasyADB/commit/bea7ea166d0ecd570f0e51b7470df056b9fefa85) |
| 旧元数据响应覆盖新列表 | [x] | 同一访问密钥代次内也核对最新 GET 的归属；迟到响应不复活已删除设备，不覆盖较新的发现结果。 | [88d67bf](https://github.com/CiBeDerORG/EasyADB/commit/88d67bf6290e7aee104108500357d0058d6f00a9) |
| 副屏旧请求污染新弹窗 | [x] | 请求、JSON、最终刷新和 finally 核对弹窗/设备/地址/代次；关闭、重开、换设备后旧结果不更新新状态或 preview ID。 | [a764ffe](https://github.com/CiBeDerORG/EasyADB/commit/a764ffe19f4b4ea9ea2fcc9f4e65d1fd7b317bb3) |
| 仅选排队设备时不能批量停止 | [x] | 按钮候选和计数包含启动队列；保留原 stopSelected、清理计数及未选设备状态。 | [1ff989b](https://github.com/CiBeDerORG/EasyADB/commit/1ff989ba6894c00c28666f92e36e6a15fdb42fea) |
| 含斜杠的分组不能管理 | [x] | 按 ASGI raw_path 匹配编码后的分组段，再解码一次；支持分组 CRUD 和发现子路由，不混淆字面 %2F。 | [28fc670](https://github.com/CiBeDerORG/EasyADB/commit/28fc6704d3be12e9744560c83ee96f5496c55032) |
| 手动和定时部署并发标记错误 | [x] | 两个入口使用同一项目锁；保存构建开始时的 tree，构建期间 tree 改变时不前移成功标记。 | [6c45324](https://github.com/CiBeDerORG/EasyADB/commit/6c45324287869bd52793cf904f5711422d799f98) |
| 定时任务误删同名前缀项目 | [x] | cron 管理只匹配完整项目标记，保留同名前缀及含空格、反斜杠、正则字符的其他项目。 | [96b57b1](https://github.com/CiBeDerORG/EasyADB/commit/96b57b113152377b9df5221ed8b4f4e196c6ad16) |

既有成果：未确认清理会话的设备、线路和分组修改保护已在 [b8d9f22](https://github.com/CiBeDerORG/EasyADB/commit/b8d9f229ed64fc40c86939974b677b28a5042550) 完成，[CI #39567508233](https://github.com/CiBeDerORG/EasyADB/actions/runs/39567508233) success，18 项新增回归及当时 322 项全量 Python 通过；本轮保留该保护。

此前怀疑“普通连接失败仍弹成功提示”，经真实 ASGI 路径配合假 ADB 验证不成立：失败返回 502，前端进入错误路径。该项已撤回，不列为缺陷。`.env` 单引号兼容与依赖方向门禁只保留为低优先级建议，没有伪装为已确认 BUG 或本轮完成项。

## 二、V4-05 细分任务清单

D2、D3 是对已经讨论的 D 阶段范围进行编号，方便后续接续，不新增业务需求。D1、D2、D3 均已完成自动化验收，D 阶段完成；E、F 也已完成，V4-05 整项完成。A～E 条目记录当时的交付边界；其中提到的临时回退现已由 F 删除，当前实现以 F 记录和关键入口表为准。

| 子项 | 状态 | 工作内容与边界 |
| --- | --- | --- |
| V4-05-A：样式外置 | [x] | 原内联 CSS 迁至 `web/assets/legacy-page.css`，保持界面；精确样式资源路由与旧测试读取位置同步。最终修复 `20c3e6f`，CI #39519904579 success。 |
| V4-05-B：设备展示模型 | [x] | `device-list-model.js` 承担设备分组、ADB 可用判定、连接优先展示排序；不修改原始批量输入顺序。最终修复 `f8f8446`，CI #39523931430 success。 |
| 补充修复：批量操作锁 | [x] | 区分设备级 `deviceBusy()` 和包含页面锁的 `deviceLocked()`；修复删除/检查循环被自身 `loading=true` 全部拦截的问题。代码 `f979d05`、测试修正 `86d60c3`；CI #39534374437 success。 |
| V4-05-C：设备列表 View | [x] | `device-list-view.js` 接管生产分组、卡片、IP 地址和操作按钮 DOM；通过回调委托业务动作，不自行发起 ADB/投屏。保留预装配兼容路径。最终代码 `24d9aba`，CI #39535465130 success。 |
| V4-05-D1：加载与连接 Controller | [x] | `device-connection-controller.js` 接管列表加载、逐台连接及结果回写；4 台并发、完成一台开放一台、失败隔离、访问密钥代次隔离。代码 `e0f93b9`，CI #39538918141 success。 |
| **V4-05-D2：批量设备管理** | **[x]** | `device-management-controller.js` 接管选择、全选、批量删除和批量检查；共用页面 `managementSelected`，保留旧 VM 兼容路径、删除确认、设备忙碌与选择复核、失败汇总、一次最终刷新及密钥代次隔离；预装配/生产入口共享 `managementBatch`，旧响应不能释放新批次锁。代码 `c76ba59`，CI #39546828783 success；未执行实机验收。 |
| **V4-05-D3：设备与线路协调** | **[x]** | `device-configuration-controller.js` 接管设备新增/编辑、临时 IP 保存/移除及线路保存后一次显式连接；沿用原 API、共用端口、删除确认和设备级忙碌规则。共享 `configurationOperation`，隔离密钥代次与迟到结果，并兼容 D1 并行元数据刷新。代码 `22313af`，CI #39549345999 success；弹窗布局与校验保持原样，其余事件留待 E，旧回退留待 F，未执行实机验收。 |
| **V4-05-E：剩余弹窗与事件** | **[x]** | `device-dialog-controller.js`、`group-dialog-controller.js`、`group-discovery-view.js` 接管尚内联的弹窗事件、两类配对、分组保存/删除/发现及结果 DOM；复用 D3 和 shared Dialog，保留五个既有 dialog、校验、关闭/键盘/焦点及已外置功能。共享配对/分组/扫描 owner 与弹窗 revision，覆盖旧请求跨 bootstrap、密钥代次隔离及部分保存重试。代码 `393de42`，CI #39551875973 success；兼容回退留待 F，未执行实机验收。 |
| **V4-05-F：兼容层清理** | **[x]** | `page-controller.js` 直接装配唯一页面状态/事件；HTML 不再含脚本实现。MultiView 显式接收四个 live 工厂和共享选择端口，删除延迟握手及重复画质/调度/会话回退。原契约迁到真实模块和 DOM；两个投屏 fixture 使用未修改的生产 20 路上限。MultiView 与 HTML 纳入规范检查，仅保留六份唯一旧实现和原样 CSS 的精确豁免。代码 `44aad3b`，CI #39557844420 success。 |

## 三、V4-05-D2 已完成：批量设备管理拆分与验收（历史记录）

### 实现范围

- 将单设备勾选、全选/取消全选、批量删除、批量检查的业务协调迁到独立 Controller；具体模块命名按前端规范，不能为了抽离而复制第二份选择或设备状态。
- 页面/View 继续负责 DOM 与事件入口，通过窄接口调用 Controller；投屏继续沿用同一个 `managementSelected` 选择来源。
- 保留现有批量删除确认提示、失败设备汇总和完成后刷新；批量检查仍然只检查状态，不主动连接、不切换线路、不自动投屏。
- 设备级连接/投屏/清理忙碌状态必须继续保护目标设备；页面锁不能阻止当前批次执行自身操作。候选设备筛选后、每台请求发出前仍需复核设备状态。
- 预装配内联请求与新 Controller 共用 `managementBatch`；访问密钥重置先递增代次再取消批次。请求、JSON 解析和最终 D1 列表刷新完成后核对所属批次，过期结果不更新选择、不继续队列、不释放新锁。
- 不同时迁移 D3、E、F，不改 D1 的 4 台连接并发或逐台开放机制，不新增需求、不改后端协议。

### 必须保留或补充的行为回归

- [x] 单选与全选/取消全选沿用当前规则；正在连接的设备不被错误纳入可操作集合，投屏批量选择来源不分叉。
- [x] 删除需要确认；取消确认不发出删除请求，未选设备不被删除。
- [x] 正常候选能够执行，不再因本批次的 `loading=true` 全部被跳过。
- [x] 提前忙碌与执行中变忙的设备被跳过，其他合格设备仍能处理；单台失败不吞掉其他设备结果。
- [x] 成功、部分失败和刷新失败等结束路径正确释放本轮状态；计数、选择保留/移除和最终刷新符合原有交互。
- [x] 修改访问密钥或状态重置后，旧异步结果不污染新列表、新选择或新批次。
- [x] 测试执行真实新 Controller 和页面接入路径，不只是源码字符串匹配；旧锁修复、D1、C、投屏和全量回归继续通过。

上述七项在 `tests/device_management_controller_contract.cjs`、`tests/device_management_lifecycle_contract.cjs`、原批量锁旧/新双路径及全量回归中得到自动化覆盖；代码 `c76ba59` 的 CI #39546828783 success。自动化通过不等于真实浏览器或实机通过。

## 四、V4-05-D3 已完成：设备与线路协调拆分与验收

### 实现范围

- 新增 `device-configuration-controller.js`，由 `app/main.js` 一次性注入；页面表单取值、View 回调通过窄接口委托设备保存、临时 IP 保存/移除和线路切换，不复制设备数组或批量选择 Set。
- 新增/编辑设备仍只 POST/PUT 保存，更新单设备焦点并刷新元数据；临时 IP 与共用端口一起保存，移除传 `{ip:null,port:null}` 并保留确认。这两类操作不主动连接、切线路或投屏。
- 不同线路严格执行 route PUT 后一次 connect；点击当前线路跳过 route PUT，仍连接一次。请求失败不回退或重试；请求前与 route 返回后再次核对设备、线路身份和忙碌状态，页面自身锁不阻止本轮操作。
- D1 仍可连接其他设备，已完成的空闲设备继续允许配置。线路操作允许同一轮的原地址和已确认目标地址两种元数据快照，避免并行 GET 返回顺序造成误判；设备消失或变为第三个地址仍拒绝后续连接。
- 页面与旧内联兼容路径共享 `configurationOperation`，构造保留装配前的任务；每次请求、JSON 和最终刷新后核对 operation/代次。密钥重置取消本轮任务，旧结果不能回写状态、关闭新弹窗、继续连接或释放新锁。
- 设备/临时 IP 保存成功与后续刷新失败分开反馈，避免把已成功保存当成失败并重复提交。渲染、请求和刷新异常均释放本轮状态；保留五个 dialog 的布局、校验、焦点和关闭保护，不同时迁移 E/F。

### 已执行的行为回归

- [x] 新增/编辑的 URL、请求体、选中焦点、关闭/失败回调、一次刷新及不自动连接；不改批量选择来源。
- [x] 临时 IP/共用端口保存，移除确认与取消、确认后再次核对忙碌状态；移除保留共用端口。
- [x] 当前/不同线路的准确请求顺序和一次连接；保存/连接失败不回退重试；PUT 后变忙、设备消失或第三地址阻止继续连接。
- [x] 七类请求/JSON 等待阶段及三类最终刷新阶段的迟到成功/失败隔离；重置后旧任务不污染新任务及弹窗。
- [x] 真实页面 form/temp/View/token 接入，旧内联操作跨 bootstrap 后的任务归属，以及真实 D1 元数据交错回归。
- [x] 保存已成功但刷新 false/抛错、初次渲染异常等结束路径释放锁；D1/D2/C/投屏及全部既有门禁继续通过。

以上由 `tests/device_configuration_controller_contract.cjs` 和完整 CI 验证；代码 `22313af` 的 CI #39549345999 success。静态资源增加精确 HTTP 白名单、MIME/no-store 与非法同目录路径回归。自动化通过不等于实机验收通过。

## 五、V4-05-E 已完成：剩余弹窗与事件拆分及验收

### 实现范围

- 新增 `device-dialog-controller.js`，负责设备、临时 IP、首次配对弹窗的填值、打开/关闭、焦点、表单及配对事件；设备/临时地址保存继续委托 D3，不创建第二份设备列表、选择集合或保存业务。
- 两类配对分别沿用 `/api/pair` 和 `/api/devices/:id/pair`；首次配对绑定打开时的设备及 `selected_serial`，发请求前复核设备、线路与忙碌状态。成功只反馈本次配对结果并清码，仍由用户手动连接。
- 新增 `group-dialog-controller.js`，负责分组弹窗、保存/删除、发现授权测试及显式扫描；`group-discovery-view.js` 只呈现本次端点结果。测试使用当前未保存表单，不保存配置或刷新设备；正式扫描单次刷新并显示原 keyed toast，不自动连接或投屏。
- 保存开始时快照完整表单；基本分组保存成功即记录 `saved.name`，发现配置失败后的重试继续 PUT。原发现配置状态跨重命名、部分失败及模块装配保留，避免重试遗漏应执行的配置 DELETE。保存或扫描已成功但后续列表刷新失败时单独提示，保留已完成结果及扫描明细。
- 配对与分组变更共享页面操作 owner，扫描使用原 `scanningGroups` 与每组 owner Map，保持不同组独立并发。请求、JSON 和最终刷新后核对身份/代次，写入弹窗再核对 revision/目标；旧响应不清新码、不改新密码、不关闭新弹窗、不释放新锁或移除新一轮同名扫描。
- 页面一次性注入后由新模块绑定事件，旧监听显式退出，公开包装函数转发；装配前操作仍共享所有权。五个静态 dialog 与原生校验属性保持原样，`display-lab.js` 及既有画质弹窗继续复用，临时 IP 弹窗不增加背景点击关闭。显式旧回退保留到 F，本轮不清理兼容层或收紧豁免。

### 已执行的行为回归

- [x] 实际 HTML ID、五个 dialog、required/端口范围/配对码 pattern、只读 IP、焦点、关闭/取消/背景点击及忙碌保护。
- [x] 真实 shared Dialog、D3 与页面 View/表单入口；重复 bootstrap、重复 bind 和旧/新监听并存时仅执行一次请求。
- [x] 通用地址与设备限定配对、参数快照、目标忙碌/消失/线路变化，以及 request/JSON 迟到成功失败和异常释放。
- [x] 新建/编辑/删除分组、取消确认/确认后变忙、发现配置 PUT/DELETE、部分成功后 PUT 重试及重命名删除配置失败跨 bootstrap 重试。
- [x] 发现测试不刷新、正式扫描一次刷新/结果 DOM 一致、同组排他/不同组并发；刷新 false/抛错保留本次扫描明细。
- [x] 旧内联配对、D3 配置和分组保存/删除/测试/扫描在 request、JSON、适用的最终刷新阶段跨 bootstrap/token，保护新 owner、锁、表单、按钮和扫描状态。
- [x] 新增三个精确 HTTP 资源白名单及非法同目录路径回归；全部旧 Node/UI、Python、Shell/OpenWrt、V2/V4 适用门禁保留。

以上由 `tests/device_dialog_controller_contract.cjs`、`tests/group_dialog_controller_contract.cjs` 与完整 CI 验证。代码 `393de42` 对应 CI #39551875973 success；自动化通过不等于真实浏览器或实机验收通过。

## 六、V4-05-F 已完成：兼容层清理与验收

### 实现范围

- `index.html` 删除整段内联 JS，`main.js` 直接调用 `createPageController()`；不再有延迟注入事件、预装配旧入口、重复监听或按 Controller 是否存在选择实现的分支。
- `page-controller.js` 只负责唯一状态与跨模块协调；抽屉/全屏/透明度迁至 shared UI，设备列表及工具栏呈现迁至管理 View。连接、批量管理、配置、弹窗和分组继续使用已经验收的真实模块；构造不主动加载设备、ADB 连接、扫描或投屏。
- MultiView 保留既有精确 URL 和全局入口，构造前校验四个 live 工厂与两个共享选择端口。删除备用质量选项/弹窗、调度队列、会话绑定/停止/清理实现；隐藏 picker 与画质弹窗共用质量模块唯一选项定义，不再维护第二个选择 Set。群控等真实消费者需要的 card/scheduler 字段仅转发至唯一资源所有者。
- 页面测试统一执行真实 page factory、Controller 和 View。旧 inline 切片、bootstrap 握手和源码位置断言迁移为真实模块、实际 DOM/异步行为契约；旧请求跨代、重新装配和新任务并行的 owner/锁/表单保护继续覆盖。两个投屏 fixture 不再修改生产常量，真实验证 20 路容量和启动预算。
- 删除 `m2-multi.js` 的 lint/format 豁免，把纯 HTML 实际加入 format:check；六份尚无替代实现的原 IIFE 与原样 CSS 保留逐文件例外，禁止扩大 ignore。七个既有脚本的公共 URL 名单与六个质量豁免分别检查。
- 新增 page controller、drawer、management view 三个精确资源白名单及 MIME/no-store/非法路径测试。后端业务、REST/WS wire 字段、DB、V2 SessionManager、DIRTY、20 路和 WebRTC-only 不变。

### 验收

- [x] 真实页面单次初始化、同 document 幂等、共享设备数组与选择 Set、明确工厂端口，初始化不触发设备业务请求。
- [x] D1～E 原行为及异步隔离保留：4 台 ADB 并发、逐台开放、选择/全选、删除/检查、设备/线路、五个 dialog、配对和分组/发现。
- [x] 真实 20 路容量、21 台拒绝且不部分启动、停止未确认不释放名额、确认清理后只释放对应一槽，旧卡片/队列回调不影响新会话。
- [x] 对照前版 206 个静态元素和全部属性语义一致，仅 HTML/CSS 属性空白格式化；五个 dialog 和原校验保留。存储访问受限时抽屉仍使用默认透明度并可打开。
- [x] 276 项 pytest、21 个 Node/UI 入口、4 个架构/模块入口、npm ci、lint/format、27 份 JS/6 份 Shell 语法、3 项部署契约与 OpenWrt smoke 通过；最终代码 CI #39557844420 success。
- [x] V2 专用 release gate 因分支条件 skipped；全量 pytest 包含 V2 回归。没有将 Mock 通过计为真实浏览器/设备验收。

代码 [44aad3b](https://github.com/CiBeDerORG/EasyADB/commit/44aad3bb522f784b7a09a2037c5b67cdabc485ab) 的远端 tree 与本地验收版本一致。F 完成后 V4-05 整项完成；其后用户指定的部署补充和 BUG 修复状态见本文件顶部。

## 七、关键代码与测试入口

| 文件 | 接续时关注点 |
| --- | --- |
| `web/index.html` | 仅保留原静态页面结构、五个 dialog、外部脚本与模块入口；没有内联业务 JS，纳入 Prettier 检查。 |
| `web/app/main.js`、`web/app/page-controller.js` | 直接创建单一页面工厂；WeakMap 保证同 document 幂等，共享设备数组、选择 Set、各业务 owner 与失效代次，负责跨模块协调和窄端口接入。 |
| `web/shared/ui/inventory-drawer.js`、`web/features/devices/device-management-view.js` | 原抽屉/全屏/透明度交互，以及设备列表装配、批量工具栏计数和禁用状态；不发起业务网络请求。 |
| `web/m2-multi.js`、`web/features/live/` | 既有公开 MultiView 入口保留，但无延迟注入或备用实现；四个工厂必需，单路/队列/画质/DOM 各归唯一模块，管理选择直接读取页面 Set。 |
| `web/features/devices/device-list-model.js` | 已完成的分组、连接判断与展示排序，后续迁移继续复用。 |
| `web/features/devices/device-list-view.js` | 已完成的列表 DOM；通过状态和动作接口衔接，不接管网络请求或视频会话。 |
| `web/features/devices/device-connection-controller.js` | 已完成的 D1；直接共享页面设备、选择、连接中集合、结果快照、代次与 AbortController，不复制业务状态。 |
| `web/features/devices/device-management-controller.js` | 已完成的 D2；共享页面选择 Set、设备状态与批次所有者，提供选择汇总、确认删除、状态检查和代次隔离；保留删除后刷新失败时移除已删记录的行为。 |
| `web/features/devices/device-configuration-controller.js` | 已完成的 D3；共享设备列表、单设备焦点、页面锁与操作所有者，协调设备/临时地址保存及线路一次连接，不接管 Dialog 或 D1/D2 状态。 |
| `web/features/devices/device-dialog-controller.js` | E 的设备/临时地址/首次配对弹窗及两类配对；共享表单身份与配对 owner，设备保存委托 D3，复用 shared Dialog。 |
| `web/features/devices/group-dialog-controller.js`、`group-discovery-view.js` | E 的分组弹窗、部分保存重试、删除与每组发现生命周期；结果 View 只呈现本次扫描。 |
| `tests/helpers/page-fixture.cjs` | 从真实 HTML 构造 DOM，调用实际 page factory；仅隔离网络和外部 Multi/Group/Lab，支持多 listener、表单/焦点、fake clock 和延迟 I/O。不得复制旧业务实现。 |
| `tests/device_dialog_controller_contract.cjs` | 实际 Dialog/D3/View/配对、同 document 重复装配和 token 失效；覆盖新旧配对/分组 owner、表单与提示隔离。 |
| `tests/group_dialog_controller_contract.cjs` | 真实分组表单/事件、部分成功重试、确认后复核、每组扫描、异步隔离、刷新失败及发现结果各状态 DOM 语义；已接入 CI。 |
| `tests/device_configuration_controller_contract.cjs` | D3 真实 Controller 与页面 form/temp/View/token/同 document 重复装配回归，覆盖保存/刷新失败、各异步阶段隔离及真实 D1 元数据交错；已接入 CI。 |
| `tests/bulk_management_lock_contract.cjs` | 执行唯一真实页面及 Controller，保留批量任务不被自身页面锁跳过、逐设备再次检查忙碌状态等原断言。 |
| `tests/device_management_controller_contract.cjs` | D2 真实 Controller + 页面装配、全选/单选、确认取消、前后忙碌、失败/刷新失败和代次重置行为回归，已接入 CI。 |
| `tests/device_management_lifecycle_contract.cjs` | 补充真实 View/D1 与 MultiView 选择端口共享状态、重复装配保持 owner、请求/JSON/最终 GET 成功或失败迟到、新旧批次锁隔离和刷新异常回归，已接入 CI。 |
| `tests/device_connection_controller_contract.cjs` | D1 的并发、逐台开放、代次隔离及真实页面接入回归。 |
| `tests/device_list_view_contract.cjs` | 执行真实页面/model/View 的 DOM、选择和按钮回调；检查原控件位置及无重复设备信息行。 |
| `tests/m2_multi_contract.cjs`、`tests/m2_twenty_contract.cjs` | 执行原样生产 MultiView + 真实 live 模块；保留会话/停止/重连隔离，并验证真实 20 路、超额拒绝与服务端确认前占槽。 |
| `tests/device_connect_order_contract.cjs`、`tests/progressive_connect_contract.cjs` | 连接优先排序、选择与逐台开放契约。 |
| `server/api/live_handler.py`、`server/services/live_admission.py` | 同一 WebSocket 验证、接管、等待及启动；准入 Future 和清理报告归当前请求持有，验证/等待期间退出不能迟到启动。 |
| `server/services/session_manager.py`、`live_request.py` | 最新有效请求顺序、高水位、精确 ticket/stream 身份及三项清理证明；请求协调不是第二份资源注册表。 |
| `tests/test_live_takeover.py`、`tests/test_live_request_coordination.py` | 22 项 handler 接管回归及 19 项协调回归；包含连续页面、无效/慢旧请求、校验/等待退出、迟到 SDP、DIRTY、20 槽与启动预算。 |
| `tests/helpers/live-handoff-contract.cjs` | 由既有 m2_multi 入口运行，验证旧页面本地释放、不会自动抢回、会话/设备隔离、等待队列及清理计数。 |
| `server/m2_live.py`、`server/m2_webrtc.py`、`server/m2_touch.py` | 正常 scrcpy session header 原位重置媒体段；有界 pending 队列、同 track 的 SPS/PPS/IDR 与 RTP 时间连续性，触摸保留精确尺寸校验。 |
| `tests/test_live_rotation.py`、`tests/test_webrtc_rotation.py`、`tests/test_live_rotation_handler.py`、`tests/helpers/live-rotation-contract.cjs` | 34 项新增 Python 与原 m2_multi 入口内的真实前端旋转回归；包含满额积压后只发送一次 config、真实 H.264 解码、会话/手势/旧回调隔离。 |
| `server/api/static.py`、`tests/test_v4_frontend_assets.py` | 每新增前端资源须同步精确白名单、MIME/缓存与非法路径测试，不能开放任意静态目录。 |
| `server/services/operations.py`、`device_service.py`、`device_control.py`、`group_service.py` | 记录写入前检查现有会话清理证明；检查和写入共用设备锁，分组先检查全部成员。不得在拒绝前写数据库、清缓存或停止/释放原会话。 |
| `tests/test_device_mutation_sessions.py` | 18 项真实 HTTP/SQLite/锁/SessionManager 回归，仅隔离 ADB 与 worker 资源完成；包含 DIRTY 删除重建与两种准入竞争顺序，由全量 pytest 自动执行。 |
| `.github/workflows/test.yml`、`package.json` | 验收命令与现有全部门禁的执行入口；新增测试必须接入，不能只新建文件不执行。 |

## 八、验收与交接要求

本轮修复对应 [CI #39608125557](https://github.com/CiBeDerORG/EasyADB/actions/runs/39608125557)，验收 SHA `fd58a1be46105929072891bbe8bc50adf73cfa82`；已完成且结论为 **success**，job [119249572690](https://github.com/CiBeDerORG/EasyADB/actions/runs/39608125557/job/119249572690)。已读取实际日志：**448 passed, 1 warning in 55.36s**；相对本轮起点的 414 项新增 34 项 Python 回归。唯一 pytest 警告是既有 Starlette TestClient/httpx 弃用提示。

执行当前 `.github/workflows/test.yml` 的全部适用步骤，包括依赖安装、Python 编译与全量 pytest、21 个 Node/UI 入口、4 个架构/模块入口、ESLint/Prettier、JS/Shell 语法及 OpenWrt smoke。新增前端旋转 helper 由原 m2_multi 入口实际调用，新增 Python 测试由全量 pytest 收集；工作流和旧门禁未删除。V2 分支专用 release 步骤为 skipped，全量 pytest 仍包含 V2 回归。

本轮只在该项全部代码完成并推送后触发一次完整 CI，首次 success。验收提交与修复提交的 tree 均为 `0878f36ae77cd26dc316bac945b1da5f1aeed4b7`。随后仅更新三份 V4 文档并以 `[skip ci]` 发布；文档 HEAD 未另跑 CI，发布时核对它与验收 SHA 只有文档差异、本地和远端内容一致、工作区干净。

## 当前停点

**本轮 1/1 项代码修复、推送、统一 CI 和文档交接全部完成。** 此前接管、浮窗及 BUG 修复继续保留。未执行真实设备或浏览器验收，Android App 是否仍发生进程崩溃未知；不据自动化全绿宣称实机问题全部消失。本轮汇报后停止。
