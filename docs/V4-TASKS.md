# EasyADB V4 · 前端架构与规范化重构任务

> 独立分支：refactor/v4-frontend-standards；基线 V2 HEAD 6221766994c5e5447d7e293b53ce079aee1c64dc（Actions #39451874696 success）。V3 暂缓；V2-F10 真实环境验收尚未执行。本计划不合并 M4 映射分支，不开发新业务。

## Agent 接续摘要

更新时间：2026-10-21。本文件是 V4 当前任务清单与下一位 Agent 的交接入口；历史提交、失败原因和验收记录见 [V4-PROGRESS.md](V4-PROGRESS.md)，开发规范见 [V4-FRONTEND-STANDARDS.md](V4-FRONTEND-STANDARDS.md)。

| 项目 | 当前交接状态 |
| --- | --- |
| 仓库 | `CiBeDerORG/EasyADB` |
| 工作分支 | `refactor/v4-frontend-standards`；不要使用默认 `main` 作为本轮开发基线 |
| 已完成 | V4-01～V4-04；V4-05 的 A、B、批量操作锁修复、C、D1、**D2**，均已自动化验收 |
| 当前停点 | **D2 完成；D3 尚未开始，D 阶段和 V4-05 仍为进行中** |
| 下一项 | **V4-05-D3：设备与线路协调**；须由用户下一次明确指示后才开始 |
| 后续顺序 | D3（设备与线路协调）→ E（剩余弹窗事件）→ F（兼容清理）→ V4-06 |
| 最近已验收代码 | [3005f78](https://github.com/CiBeDerORG/EasyADB/commit/3005f7805e40f52745ab36baacedb88d516b4d68)，[CI #39546411435](https://github.com/CiBeDerORG/EasyADB/actions/runs/39546411435) success |
| 上次 Agent 交接文件提交 | [1aeab79](https://github.com/CiBeDerORG/EasyADB/commit/1aeab79d83573f9fe08ba2256ec820fd45ec3eb8)，[CI #39542414459](https://github.com/CiBeDerORG/EasyADB/actions/runs/39542414459) success |
| 尚未执行 | 真实浏览器、FNOS/NAS、Android、OpenWrt/EasyTier 部署与设备验收；V4-06 未开始，V3 暂缓 |

以上 SHA 是交接快照，不是要求回退到固定版本。下一位 Agent 必须先读取远端最新分支 HEAD、工作区改动以及本文件和进度文件；若已有更新，基于新状态接续，不覆盖他人提交、不重复完成项。D2 已完成代码提交和自动化验收；本次仅更新 D2 状态并交接下一待办，不启动 D3。

## 执行规则

- **遵循用户最新要求：一次只处理一个明确的小项，修完、提交并验收后汇报，然后停止；收到“继续”才进入下一项。** 这条取代此前“简单任务可以一次做两项”的约定。复杂阶段可以再分小步，但不得把一个小步完成写成整个阶段完成。
- 每项代码与定向测试独立提交，完整旧 CI+新增门禁通过后再单独更新进度；复核最新 HEAD 的 CI，未验证不得打钩。失败时只修当前项。
- 新增代码遵循 [前端命名与架构规范](V4-FRONTEND-STANDARDS.md)；旧 IIFE、内联 HTML/CSS 不批量改名/格式化，兼容豁免随着逐项迁移收紧。
- 不更改外部 REST/WS 协议、数据库、V2 SessionManager、DIRTY 资源所有权、20 路逻辑上限、WebRTC-only 或页面交互；不执行 FNOS/NAS/Docker/Android/OpenWrt/EasyTier 真实部署。
- 不合并 `refactor/session-v2` 或 `feat/m4-screen-mapping-m1`，不擅自切换开发分支或推进 V3。任务文件中的后续待办不是一次执行全部的授权。
- 每完成一个小项，同步本文件的状态、当前停点与下一项，以及 `docs/V4-PROGRESS.md` 的提交/CI/未验证事项，避免下一位 Agent 仅依赖聊天记录。

## 一、V4 总体进度

状态说明：`[x]` = 对应代码与自动化验收完成；`[~]` = 进行中；`[ ]` = 未开始或待处理。自动化通过不等于实机验收通过。

| ID | 优先级 | 状态 | 最小交付与验收 |
| --- | --- | --- | --- |
| V4-01 | P0 | [x] | **前端架构、命名及代码规范门禁**：新增 `V4-FRONTEND-STANDARDS.md`、EditorConfig、ESLint、Prettier、锁定 npm 依赖及 Node 架构测试；增量约束新模块的目录/文件命名、camelCase、禁止新增 window 全局业务导出。旧七份 IIFE 和 `index.html` 显式豁免，不批量格式化；`node_modules/` 从 Git/Docker 构建上下文排除。V4 CI 独立执行 `npm ci`、lint、format 和命名门禁，原 Python/Node/Shell/OpenWrt 回归继续运行。最终代码提交 [3548925](https://github.com/CiBeDerORG/EasyADB/commit/3548925e1fe0343ff86cd255a7a643e335fdc061)，[CI #39456125975](https://github.com/CiBeDerORG/EasyADB/actions/runs/39456125975) success；未修改原业务脚本。 |
| V4-02 | P0 | [x] | **公共 ES Modules 抽离**：新增 API Client、DOM、Toast、Dialog 模块及 `app/main.js` 一次性装配；原页面通过兼容适配层使用，无新增 window 业务全局。Toast 键值替换、计时、旧回调隔离，Dialog 焦点和表单校验仍兼容。静态服务新增五个精确 GET 资源白名单、不开放通配目录；补 Node 模块行为、HTTP 白名单、原页面契约测试。最终代码 [485ecc3](https://github.com/CiBeDerORG/EasyADB/commit/485ecc34c90929c4e290cb2fd34fde46074d55dc)，[CI #39458266192](https://github.com/CiBeDerORG/EasyADB/actions/runs/39458266192) success；未改 V2 SessionManager/DB/协议。 |
| V4-03 | P0 | [x] | **单路 LiveSessionController 资源所有权**：新增 `web/features/live/live-session-controller.js`，由 V4-02 的一次性 ES Module 装配注入生产 `MultiView`；每台设备本轮独占 WS、WebRTC Player、Touch、Meter/QualityMeter、sessionId、帧回调及停止计时器。卡片旧字段仅为兼容访问器，服务端 SessionManager 仍为清理与槽位释放权威。回调核对当前卡片/Socket，Session ID 不允许被另一个值覆盖，迟到结束/错误/停止超时不能影响替代会话；仅服务端确认清理后允许显式一次性重连。保留原多画面、群控、20 路及页面接口，旧 Node VM fixture 已注入真实新控制器执行集成回归；新增独立生命周期/诊断隔离测试和精确静态资源白名单。最终代码 [a205512](https://github.com/CiBeDerORG/EasyADB/commit/a2055120185c823bcc6065ddabc372221ee70d9a)，[CI #39461806736](https://github.com/CiBeDerORG/EasyADB/actions/runs/39461806736) success。真实环境验收仍待 V2-F10。 |
| V4-04 | P0 | [x] | **MultiView 职责拆分**：新增 `features/live/live-batch-scheduler.js`（启动队列、批量代次、并发预算与完成回调）、`live-card-view.js`（画面容器、宽高自适应、会话诊断与悬浮日志 DOM）、`live-quality-settings.js`（设备画质 Map、wire payload、实验性分辨率及参数弹窗），通过 `app/main.js` 单次 ES Module 装配注入。首次使用懒装配，继承页面已有画质选项与服务器下发 `max_starting`；保留原字段兼容代理及旧 VM 回退，供 V4-05 逐项清理。新增三个精确静态 JS 白名单；旧多画面/20 路 Node 契约已注入真实三个模块，增强了先建页面后装配的数据保留回归。最终代码 [5335af0](https://github.com/CiBeDerORG/EasyADB/commit/5335af034b039346994c6495706d2500e9875a01)，[CI #39464539417](https://github.com/CiBeDerORG/EasyADB/actions/runs/39464539417) success。 |
| V4-05 | P1 | [~] | **设备管理及页面 JS/CSS 模块化**：保持现有 DOM、五个 dialog 和交互。A 样式外置、B 设备模型、C 列表 View、D1 加载/连接 Controller、D2 选择/全选/删除/检查 Controller 已完成自动化验收。D2 最终代码 [3005f78](https://github.com/CiBeDerORG/EasyADB/commit/3005f7805e40f52745ab36baacedb88d516b4d68)，[CI #39546411435](https://github.com/CiBeDerORG/EasyADB/actions/runs/39546411435) success。设备列表与选择 Set 继续共享，不重写 D1；D3 设备/线路协调、E 弹窗与 F 兼容清理仍待分步迁移，整项不打勾。 |
| V4-06 | P0 | [ ] | **收尾全量回归与验收记录**：V4-05 完成后执行全量 Python/Node/Shell/OpenWrt + V2/V4 门禁；明确剩余实机项目归 V2-F10/单独验收，不以 Mock 替代，不把之前各步的 CI 通过当成本项已经执行。 |

## 二、V4-05 细分任务清单

D2、D3 是对已经讨论的 D 阶段剩余范围进行编号，方便后续接续，不新增业务需求。D1、D2、D3 全部完成之前，不能把 D 阶段标为完成。

| 子项 | 状态 | 工作内容与边界 |
| --- | --- | --- |
| V4-05-A：样式外置 | [x] | 原内联 CSS 迁至 `web/assets/legacy-page.css`，保持界面；精确样式资源路由与旧测试读取位置同步。最终修复 `20c3e6f`，CI #39519904579 success。 |
| V4-05-B：设备展示模型 | [x] | `device-list-model.js` 承担设备分组、ADB 可用判定、连接优先展示排序；不修改原始批量输入顺序。最终修复 `f8f8446`，CI #39523931430 success。 |
| 补充修复：批量操作锁 | [x] | 区分设备级 `deviceBusy()` 和包含页面锁的 `deviceLocked()`；修复删除/检查循环被自身 `loading=true` 全部拦截的问题。代码 `f979d05`、测试修正 `86d60c3`；CI #39534374437 success。 |
| V4-05-C：设备列表 View | [x] | `device-list-view.js` 接管生产分组、卡片、IP 地址和操作按钮 DOM；通过回调委托业务动作，不自行发起 ADB/投屏。保留预装配兼容路径。最终代码 `24d9aba`，CI #39535465130 success。 |
| V4-05-D1：加载与连接 Controller | [x] | `device-connection-controller.js` 接管列表加载、逐台连接及结果回写；4 台并发、完成一台开放一台、失败隔离、访问密钥代次隔离。代码 `e0f93b9`，CI #39538918141 success。 |
| **V4-05-D2：批量设备管理** | **[x]** | `device-management-controller.js` 接管选择、全选、批量删除和批量检查；共用页面 `managementSelected`，保留旧 VM 兼容路径、删除确认、设备忙碌复核、失败汇总、一次最终刷新及密钥代次隔离。代码 `3005f78`，CI #39546411435 success；未执行实机验收。 |
| V4-05-D3：设备与线路协调 | [ ] | 继续迁移设备新增/编辑、临时 IP、线路切换等业务协调；沿用现有 API、保存/连接语义和设备级忙碌规则。不在此轮同时改造弹窗布局或扩展业务。 |
| V4-05-E：剩余弹窗与事件 | [ ] | 迁出剩余弹窗业务事件；复用已有 Dialog 基础能力，保持五个既有 dialog 的校验、关闭保护、键盘/焦点及原有交互。已经外置的功能不重复重写。 |
| V4-05-F：兼容层清理 | [ ] | 在生产入口和行为测试稳定后，逐项删除已替代的重复实现、迁移旧 VM/源码位置测试、收紧 ESLint/Prettier 豁免。不得通过删测、跳过门禁或保留永久双实现冒充迁移完成。 |

## 三、V4-05-D2 已完成：批量设备管理拆分与验收

### 实现范围

- 将单设备勾选、全选/取消全选、批量删除、批量检查的业务协调迁到独立 Controller；具体模块命名按前端规范，不能为了抽离而复制第二份选择或设备状态。
- 页面/View 继续负责 DOM 与事件入口，通过窄接口调用 Controller；投屏继续沿用同一个 `managementSelected` 选择来源。
- 保留现有批量删除确认提示、失败设备汇总和完成后刷新；批量检查仍然只检查状态，不主动连接、不切换线路、不自动投屏。
- 设备级连接/投屏/清理忙碌状态必须继续保护目标设备；页面锁不能阻止当前批次执行自身操作。候选设备筛选后、每台请求发出前仍需复核设备状态。
- 不同时迁移 D3、E、F，不改 D1 的 4 台连接并发或逐台开放机制，不新增需求、不改后端协议。

### 必须保留或补充的行为回归

- [x] 单选与全选/取消全选沿用当前规则；正在连接的设备不被错误纳入可操作集合，投屏批量选择来源不分叉。
- [x] 删除需要确认；取消确认不发出删除请求，未选设备不被删除。
- [x] 正常候选能够执行，不再因本批次的 `loading=true` 全部被跳过。
- [x] 提前忙碌与执行中变忙的设备被跳过，其他合格设备仍能处理；单台失败不吞掉其他设备结果。
- [x] 成功、部分失败和刷新失败等结束路径正确释放本轮状态；计数、选择保留/移除和最终刷新符合原有交互。
- [x] 修改访问密钥或状态重置后，旧异步结果不污染新列表、新选择或新批次。
- [x] 测试执行真实新 Controller 和页面接入路径，不只是源码字符串匹配；旧锁修复、D1、C、投屏和全量回归继续通过。

上述七项在 `tests/device_management_controller_contract.cjs`、原批量锁测试及全量回归中得到自动化覆盖；代码 `3005f78` 的 CI #39546411435 success。自动化通过不等于真实浏览器或实机通过。

## 四、关键代码与测试入口

| 文件 | 接续时关注点 |
| --- | --- |
| `web/index.html` | 仍包含共享页面状态、批量选择/删除/检查事件、CRUD/线路/弹窗协调以及显式旧兼容路径；按最新源码定位，不依赖旧行号。 |
| `web/app/main.js` | ES Module 一次性装配入口，不新增 window 业务全局，不在初始化时主动连接设备。 |
| `web/features/devices/device-list-model.js` | 已完成的分组、连接判断与展示排序，不能为了 D2 重新实现一套。 |
| `web/features/devices/device-list-view.js` | 已完成的列表 DOM；通过状态和动作接口衔接，不接管网络请求或视频会话。 |
| `web/features/devices/device-connection-controller.js` | 已完成的 D1；通过页面访问器共享设备、选择、连接中集合、结果快照、代次与 AbortController，不复制业务状态。 |
| `web/features/devices/device-management-controller.js` | 已完成的 D2；共享页面选择 Set 和设备状态，按设备忙碌规则执行确认删除、状态检查与密钥代次隔离；不发起自动连接。 |
| `tests/bulk_management_lock_contract.cjs` | 保留的旧页面批量删除/检查自锁与设备忙碌复核回归。 |
| `tests/device_management_controller_contract.cjs` | D2 真实 Controller + 页面装配、全选/单选、确认取消、前后忙碌、失败/刷新失败和代次重置行为回归，已接入 CI。 |
| `tests/device_connection_controller_contract.cjs` | D1 的并发、逐台开放、代次隔离及真实页面接入回归。 |
| `tests/device_list_view_contract.cjs` | C 的新旧 DOM 一致性、选择与按钮回调回归。 |
| `tests/device_connect_order_contract.cjs`、`tests/progressive_connect_contract.cjs` | 连接优先排序、选择与逐台开放契约。 |
| `server/api/static.py`、`tests/test_v4_frontend_assets.py` | 每新增前端资源须同步精确白名单、MIME/缓存与非法路径测试，不能开放任意静态目录。 |
| `.github/workflows/test.yml`、`package.json` | 验收命令与现有全部门禁的执行入口；新增测试必须接入，不能只新建文件不执行。 |

## 五、验收与交接要求

D2 代码 `3005f78` 对应 CI #39546411435 success：276 项 Python、原有与新增 Node/UI、V4 ESLint/Prettier/架构检查、Shell 语法和 OpenWrt 烟测通过。V2 专用 release gate 因分支条件 skipped，不能写为此分支独立通过。下一位 Agent 须以当次实际 CI 结果为准。

执行当前 `.github/workflows/test.yml` 的全部适用步骤，包括依赖安装、Python 编译和全量 pytest、所有 Node/UI 回归、`npm run lint`、`npm run format:check`、`npm run test:architecture`、Shell 语法及 OpenWrt 烟测。CI 中有分支条件的步骤须按实际记录 passed/skipped，不把 skipped 写成单独执行通过。禁止临时格式化后只检查修改后的工作区来掩盖未提交的格式问题。

完成后汇报本轮实际完成的小项、变更文件、代码/文档提交 SHA、对应 CI run 与结果、尚未验证内容和唯一下一项。先验证代码提交，再更新任务状态与进度；文档提交若再次触发 CI，也核对最新 HEAD，不把旧提交的成功冒充新提交结果。

真实浏览器、FNOS/NAS、Android、OpenWrt/EasyTier 环境验收仍归 **V2-F10/单独验收**；目前未执行。V3 继续暂缓。不要执行真实设备部署，也不要以自动化 Mock 通过宣称实机可用。

## 当前停点

**已完成 V4-01～V4-04，以及 V4-05-A/B/C/D1/D2 和批量操作锁修复。D2 自动化验收通过，D 阶段与 V4-05 整项仍为进行中，V4-06 未开始。**

本轮 D2 已完成、提交、验收并更新文档，到此停止。下一轮只有收到用户明确“继续”后，才处理 **V4-05-D3：设备新增/编辑、临时 IP、线路切换等设备与线路协调**；E、F、V4-06 不提前执行。
