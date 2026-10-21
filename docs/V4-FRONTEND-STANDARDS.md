# EasyADB V4 · 前端架构与代码命名规范

> 生效范围：V4 新增及逐项完成迁移的前端代码；先冻结契约再迁移。页面、ES Modules 和已清理的 `m2-multi.js` 执行格式与代码规范检查。剩余六份尚无替代实现的历史 IIFE（`m2-webrtc.js`、`m2-traffic.js`、`m2-touch.js`、`m2-metrics.js`、`m2-group.js`、`display-lab.js`）及原样 `assets/legacy-page.css` 保留**逐文件豁免**。例外名单在 .prettierignore、eslint.config.mjs 和架构门禁中对齐，禁止通配符扩大豁免；每完成一个旧文件的迁移，就删除该项豁免。七个既有根级脚本 URL 的兼容名单与六个样式/lint 豁免分开维护。

## 一、架构责任及依赖

目标采用不引入大型 UI 框架、运行时打包器的原生 ES Modules；新资源的静态安全路由需要在 V4-02 逐项明确，不允许直接开放任意文件遍历。

- app：入口、装配、跨功能协调；不承载视频 Socket 或 DOM 业务细节。
- features/devices：设备清单、连接、分组、线路管理；不得私自创建投屏 Session。
- features/live：LiveViewManager（布局和选择）、LiveBatchScheduler（并发队列）、LiveSessionController（**单路会话唯一前端所有者**）、LiveCardView（DOM）、WebRTCPlayer（媒体接收）。
- features/control：TouchController、GroupControlToolbar；操作通过既有会话作用域，群控不另起连接。
- core：API 客户端、协议字段映射、配置和通用错误；不得依赖 features/app。
- shared：无业务状态的 DOM/格式化/UI 基元；不得反向导入 features/app。

依赖为 app → features → core/shared；features 间通过构造注入的窄接口协作，不直接篡改别人的内部 Map/DOM。禁止循环依赖、window.EasyADB* 新增全局导出或隐式全局变量。原全局 API 和精确静态 URL 保持既有契约；测试执行唯一生产实现，不为旧 VM 或源码位置断言保留第二份业务实现。`app/main.js` 直接创建 `page-controller.js`，不再使用延迟事件注入或预装配回退；MultiView 构造时显式接收四个 live 工厂与页面选择端口。

## 二、命名约定

| 对象 | 规范 | 示例 |
| --- | --- | --- |
| 新 .js/.css 文件 | kebab-case，不带 M2/V4 版本前缀 | live-session-controller.js |
| 类与控制器 | PascalCase；Controller/Manager/View/Scheduler/Player 后缀体现单一职责 | LiveSessionController |
| 变量/函数/方法 | camelCase、完整业务语义；函数以动作动词开头 | selectedDeviceIds、startNextQueuedSession() |
| 布尔 | is/has/can/should 前缀 | isConnected、hasActiveSession、canStartSession |
| 常量及枚举 | UPPER_SNAKE_CASE | MAX_LIVE_SESSIONS、SESSION_PHASE |
| 本地标识 | id 明确所属对象，不使用 d/pd/card 传递跨层信息 | deviceId、sessionId、liveCard |
| 单位 | 具备单位的数字必须写后缀 | startupTimeoutMs、pendingBytes、bitrateBps、elapsedSeconds |
| DOM id | camelCase；已有 HTML ID 先保持兼容 | liveViewContainer |
| CSS | kebab-case + 功能命名空间，BEM 元素与明确的状态类 | .live-card、.live-card__toolbar、.live-card.is-stopping |
| API/WS wire 字段 | 保持既有 snake_case 不改协议；仅在边界适配 | session_id → sessionId |

不要让新文件使用 m2-/m3-/v4- 前缀表达历史迭代。既有公共脚本不因内部清理而批量改名；全局导出、HTTP 静态资源路径和加载顺序仍须经过相应契约测试。保留公共名称不代表可以保留重复实现或格式豁免。

## 三、生命周期与状态所有权

- **状态只能有一个写入所有者**。设备选择状态属于 DeviceController；批量待启动列表属于 LiveBatchScheduler；一台设备本轮 WebSocket、RTCPeerConnection、触控、诊断和 sessionId 属于 LiveSessionController；服务端 SessionManager 是资源释放的最终权威。
- startSession() 发起显式投屏；requestStopSession() **只表示请求停止**；finalizeSession() 仅在核对当前 deviceId + sessionId 及服务端清理结果后执行；dispose() 负责局部事件监听/DOM/对象清理。不得以 WebSocket close 或黑屏推断服务端 Session 已 RELEASED。
- 停止、重复回调、页面离开、ICE 失败和旧会话异步完成均需要显式边界；旧会话回调不得更新或释放新会话；未清理的 DIRTY 槽位不复用。
- 新增代码不得在页面打开时主动 ADB 连接、扫描路由器、自动重连设备、触发投屏或建立无人页面媒体通信。视频保持 WebRTC-only，逻辑 20 路上限和服务端启动预算不改变。

## 四、编写与样式要求

- 一个类或文件有一个清楚的主职责；超长方法先拆出纯逻辑/视图/副作用，不以任意固定行数强制拆文件。
- UI View 不直接发起 ADB/WebSocket；Player 不控制批量队列；Scheduler 不直接操作设备视频 DOM。异步操作有明确异常、取消及资源清理路径；非关键统计故障可以有理由地吞掉，但不得吞清理失败。
- 不允许魔法数字；浏览器显示配置从 /api/m2/video-engine 读取，服务端继续是最终上限；协议结构及错误字段不因命名迁移静默改变。
- CSS 类按业务块命名空间，元素使用 __，状态使用 is-/has-；新样式逐步使用集中 --color-/--spacing-/--radius- 设计变量。既有 CSS 已原样迁入 `assets/legacy-page.css`，不在兼容清理中做视觉重写。
- 保留语义 HTML、可访问名称、键盘操作、自动收起/全屏、屏幕方向及原单设备/群控操作语义；重构期间不做视觉设计换代。
- 新模块的 ESLint 启用 camelcase（忽略协议对象属性与兼容解构，协议字段仅在边界映射），Prettier 统一格式；EditorConfig 采用 UTF-8、LF、2 空格及文件末尾换行。禁止一次性格式化全仓库；格式化新文件及单个已迁移模块。新代码中的命名遵守本规范，必要的旧 wire 字段仅在协议边界豁免。

## 五、提交与验收

每一项 V4 任务单独提交，新增或更新匹配的 Node 合约/行为回归；必须跑完整既有 Python/Node/Shell/OpenWrt CI 和 V2 防回退门禁。页面测试通过共享 DOM fixture 执行真实 page factory、Controller 和 View，替换历史内联切片及源码位置断言；原有业务、安全、生命周期断言不能因迁移被删除或变成对空 HTML 的检查。公共 IIFE 的 VM fixture 直接注入真实模块，禁止修改生产常量或恢复旧实现来构造测试。CI/Mock 不等同于 V2-F10/F4 真实环境压测；生产设备/SQLite/.env 均不在本规范化改造范围。
