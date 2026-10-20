# V4-04 · MultiView 模块边界及迁移记录

本轮仅拆分前端职责；真实 FNOS/Android/EasyTier 环境仍按 V2-F10 单独验收。

## 运行时模块边界

- `LiveBatchScheduler`：持有本页启动中状态、待启动队列、在途名额、批次代次和幂等完成回调。服务端 `/api/m2/video-engine` 下发的 `max_starting` 继续作为启动预算；不持有 Socket、Player 或服务端资源。MultiView 原 `opening/launchQueue/launchInFlight/launchGeneration/maxStarting` 通过代理兼容。
- `LiveCardView`：创建单张卡片的媒体容器、尺寸/方向自适应、会话诊断和悬浮日志 DOM；不启动 ADB、WebSocket/WebRTC，也不执行批量调度。后续悬浮控件行为绑定仍由 MultiView 协调。
- `LiveQualitySettings`：独立保存页面设备画质 Map、默认值、生成服务端 wire payload、实验性分辨率选项及参数弹窗；配置仅对下次投屏生效，不热切换当前 Session；保持 snake_case 协议和密码接口。
- `LiveSessionController`：沿用 V4-03，每路唯一持有 WS、Player、Touch、Session ID、Meter/QualityMeter、帧回调与停止计时器。

## 兼容和懒装配

旧 `m2-multi.js` 经典脚本在 `app/main.js` ES Module 之前创建页面，后者通过已有 `easyadb:frontend-modules-ready` 事件注入三个新模块工厂。MultiView 首次需要它们时懒装配，继承装配前画质 Map 和启动并发配置。模块未就绪时明确拒绝投屏，不建立不完整资源或暗中连接 ADB。

保留旧 IIFE 的显式兼容回退供旧 Node VM 契约逐项迁移；生产路径及 `m2_multi_contract.cjs` 已注入真实新模块，不以测试 fallback 冒充已拆分。旧 `index.html`、DOM ID、REST/WS 协议、20 路上限及 V2 DIRTY/清理所有权不变。新增静态资源只有三个明确 GET 白名单，不开放通配目录。

## 验收、后续

`m2_multi_contract.cjs` 实测新卡片、调度器和画质模块的实际集成；`m2_twenty_contract.cjs` 覆盖 20 个逻辑槽、3 个启动名额、停止保留逻辑槽及页面先创建、模块后注入时的画质偏好保留。完整 CI #39464539417 success。CI/Mock 不能替代真实硬件、浏览器及网络人工验收。

V4-05 再逐步拆分 `index.html` 内联设备管理及样式并收紧旧文件豁免。本轮在 V4-04 停止。
