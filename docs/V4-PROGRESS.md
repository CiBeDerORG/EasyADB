# EasyADB V4 改造进度

- 工作分支：refactor/v4-frontend-standards。
- 只在完成对应工作和本提交 CI 后更新。V3 暂缓，V2-F10 真实 FNOS/Android/OpenWrt/EasyTier 验收仍待执行。
- **V4-01 已完成（自动化验收）**：独立分支起点 V2 HEAD `6221766`；代码改造与修复提交依次为 `1a56a7a`、`dc6b2be`、`5ff4702`、`433d031`、最终 [3548925](https://github.com/CiBeDerORG/EasyADB/commit/3548925e1fe0343ff86cd255a7a643e335fdc061)。最终 [CI #39456125975](https://github.com/CiBeDerORG/EasyADB/actions/runs/39456125975) **success**：受支持 ESLint/Prettier 版本及 npm lock、V4 命名/格式/目录门禁、现有 Node UI 契约、完整 Python、Shell 与 OpenWrt 烟测均通过。旧版前端 IIFE 和内联 CSS 仅显式豁免，不改变运行时与 API。
- **V4-02 已完成（自动化验收）**：新增显式 API Client、DOM、Toast、Dialog ES Modules、一次性旧内联适配和精确静态资源白名单。初始提交 `bbc4055`，ESLint 环境修正 `e8ed87f`，最终格式修正 [485ecc3](https://github.com/CiBeDerORG/EasyADB/commit/485ecc34c90929c4e290cb2fd34fde46074d55dc)；[CI #39458266192](https://github.com/CiBeDerORG/EasyADB/actions/runs/39458266192) **success**。原 Python 276 项、Node/静态资源回归、Shell 和 OpenWrt 烟测均通过。真实浏览器/实机验证不以 CI 代替。
- **V4-03 已完成（自动化验收）**：生产页面通过一次性模块注入使用 `LiveSessionController`，卡片兼容字段转发给每路唯一所有者。控制器统一持有 WS、Player、Touch、诊断统计、Session ID、停止超时和帧回调；`MultiView` 保留 DOM、批量启动/停止、画质及历史摘要，旧 Session 回调不能释放新卡片，超时不等于服务端清理。现有旧式 `m2_multi_contract.cjs` 测试夹具也注入真实控制器，专用 `v4_live_session_controller.mjs` 覆盖资源绑定、不可变 Session、计时器与诊断隔离。代码提交 `6c7522f` → `1a386ff` → `b5f529f` → `f1246aa` → `8aee887` → 最终 [a205512](https://github.com/CiBeDerORG/EasyADB/commit/a2055120185c823bcc6065ddabc372221ee70d9a)，[CI #39461806736](https://github.com/CiBeDerORG/EasyADB/actions/runs/39461806736) **success**；包含现有完整 Python/Node/Shell/OpenWrt 回归。没有变更后端业务及用户数据。
- **V4-04 已完成（自动化验收）**：从 `MultiView` 抽出 `LiveBatchScheduler`、`LiveCardView`、`LiveQualitySettings`，生产入口注入三个模块，静态白名单增加三个文件。初始提交 `1014782`，格式校准 `cd5bcef` → `5e4a8bf`，修复兼容语法 `7473189`，最终延迟装配回归 [5335af0](https://github.com/CiBeDerORG/EasyADB/commit/5335af034b039346994c6495706d2500e9875a01)、[CI #39464539417](https://github.com/CiBeDerORG/EasyADB/actions/runs/39464539417) **success**。旧多画面/20 路 Mock 注入真实新模块，保留批量选择/停止、并发预算与先建页面后装配的画质配置；Python 276 项、Node、Shell、OpenWrt 与 V4 门禁全绿。旧 IIFE 回退待 V4-05 逐项迁移；未执行实机或真实浏览器人工验收。
- **V4-05 进行中，阶段 A（CI 失败，旧 CSS 契约待复核）**：原 index.html 内联 CSS 原样迁入 `web/assets/legacy-page.css`，页面通过独立精确路由引用；旧样式不批量格式化，豁免从 `index.html` 收紧到该份遗留 CSS；CSS 契约测试改为装配真实页面+样式资源，HTTP 白名单增加正常/非法路径断言。设备管理数据模型仍待阶段 B 单独迁移。本文档对应提交的 CI 尚需单独复核。
- V3 继续暂缓，V2-F10 真实 FNOS/Android/OpenWrt/EasyTier 验收仍待执行。

- 阶段 A 首次 CI #39519543834：Python 273 passed / 3 failed（旧测试仍从 HTML 寻找 CSS）；V4 格式门禁 1 处；本提交仅调整旧测试从实际外置 stylesheet 断言及格式，保持生产代码不变，后续 CI 结果另核。

- 第二次 CI #39519766739：规范门禁 success；旧 `global_toast_contract.cjs` 和一处 Python CSS 断言仍读取 HTML。此次补齐外置 stylesheet 读取位置，不放宽任何实际断言；待重新复核。

- **V4-05 阶段 A 验收**：最终修复提交 `20c3e6f`，CI #39519904579 success（现有完整 Python/Node/Shell/OpenWrt + V4 门禁）；历史 CSS 测试已对照实际样式资源，生产 CSS 内容未修改。
- **V4-05 阶段 B（待 CI）**：新增 `features/devices/device-list-model.js`，设备展示分组与连接优先排序不再写入生产页面主体。模块注入后刷新列表，旧经典脚本预装配/Node VM 显式兼容；新增纯模型行为测试与精确 JS 静态路由。连接、CRUD、五个 dialog 与 WebRTC/V2 SessionManager 不变。

- **V4-05 阶段 B 已完成（自动化验收，2026-10-21）**：模型提交 `529ba87`、格式修正 `0c0f471` 均已推送；后者的 CI #39520431989 在北京时间 08:18:42 已结束为 failure，并非 Runner 一直排队或运行。276 项 Python 和 V4 规范门禁通过，失败点是 `tests/device_connect_order_contract.cjs` 仍用源码正则要求排序直接写在 `render()` 内；阶段 B 已将其迁到注入模型/兼容函数，旧断言未同步。没有证据据此判断聊天客户端停止响应的内部原因。
- 修复提交 [f8f8446](https://github.com/CiBeDerORG/EasyADB/commit/f8f84467802cb2c481d5a4aac63edcccd2f19346) 将这两处位置断言替换为真实 `render()` 分组路径的行为验证，分别执行模块注入前后路径；验证已连接分组优先、组内稳定排序、旧线路状态排除、空组/未分组和发现配置保留、原始批量输入不变，并确认注入后确实调用生产模块。原批量连接成功选择断言保留，不通过删测/跳过门禁消除失败。
- 修复提交 [CI #39523931430](https://github.com/CiBeDerORG/EasyADB/actions/runs/39523931430) **success**：276 项 Python、V4 lint/format/架构检查、原 Node UI 契约、Shell 语法和 OpenWrt 烟测均通过。本地 17 项 Node 契约/模块入口及 Shell/OpenWrt 烟测通过；Python 结果来自 GitHub CI。
- **当前停点：V4-05 阶段 A/B 已验收，整项仍进行中**。设备管理的 DOM 渲染、CRUD/连接事件和预装配兼容代码仍在 `index.html`，旧 IIFE 回退也仍保留；后续继续分小步迁移，不把模型抽离当作页面 JS 全部迁移。V4-06 未开始；不合并 `refactor/session-v2`，不执行真实部署或设备验收。
