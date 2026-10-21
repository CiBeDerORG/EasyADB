# EasyADB V4 · 前端架构与规范化重构任务

> 独立分支：refactor/v4-frontend-standards；基线 V2 HEAD 6221766994c5e5447d7e293b53ce079aee1c64dc（Actions #39451874696 success）。V3 暂缓；V2-F10 真实环境验收尚未执行。本计划不合并 M4 映射分支，不开发新业务。

## 执行规则

- 复杂任务每轮**仅执行一项**；简单且相互独立的任务每轮最多执行连续两项，必须分别提交及验证；收到“继续”才进入下一轮。
- 每项代码与定向测试独立提交，完整旧 CI+新增门禁通过后再单独更新进度；复核最新 HEAD 的 CI，未验证不得打钩。失败时只修当前项。
- 新增代码遵循 [前端命名与架构规范](V4-FRONTEND-STANDARDS.md)；旧 IIFE、内联 HTML/CSS 不批量改名/格式化，兼容豁免随着逐项迁移收紧。
- 不更改外部 REST/WS 协议、数据库、V2 SessionManager、DIRTY 资源所有权、20 路逻辑上限、WebRTC-only 或页面交互；不执行 FNOS/NAS/Docker/Android/OpenWrt/EasyTier 真实部署。

| ID | 优先级 | 状态 | 最小交付与验收 |
| --- | --- | --- | --- |
| V4-01 | P0 | [x] | **前端架构、命名及代码规范门禁**：新增 `V4-FRONTEND-STANDARDS.md`、EditorConfig、ESLint、Prettier、锁定 npm 依赖及 Node 架构测试；增量约束新模块的目录/文件命名、camelCase、禁止新增 window 全局业务导出。旧七份 IIFE 和 `index.html` 显式豁免，不批量格式化；`node_modules/` 从 Git/Docker 构建上下文排除。V4 CI 独立执行 `npm ci`、lint、format 和命名门禁，原 Python/Node/Shell/OpenWrt 回归继续运行。最终代码提交 [3548925](https://github.com/CiBeDerORG/EasyADB/commit/3548925e1fe0343ff86cd255a7a643e335fdc061)，[CI #39456125975](https://github.com/CiBeDerORG/EasyADB/actions/runs/39456125975) success；未修改原业务脚本。 |
| V4-02 | P0 | [x] | **公共 ES Modules 抽离**：新增 API Client、DOM、Toast、Dialog 模块及 `app/main.js` 一次性装配；原页面通过兼容适配层使用，无新增 window 业务全局。Toast 键值替换、计时、旧回调隔离，Dialog 焦点和表单校验仍兼容。静态服务新增五个精确 GET 资源白名单、不开放通配目录；补 Node 模块行为、HTTP 白名单、原页面契约测试。最终代码 [485ecc3](https://github.com/CiBeDerORG/EasyADB/commit/485ecc34c90929c4e290cb2fd34fde46074d55dc)，[CI #39458266192](https://github.com/CiBeDerORG/EasyADB/actions/runs/39458266192) success；未改 V2 SessionManager/DB/协议。 |
| V4-03 | P0 | [x] | **单路 LiveSessionController 资源所有权**：新增 `web/features/live/live-session-controller.js`，由 V4-02 的一次性 ES Module 装配注入生产 `MultiView`；每台设备本轮独占 WS、WebRTC Player、Touch、Meter/QualityMeter、sessionId、帧回调及停止计时器。卡片旧字段仅为兼容访问器，服务端 SessionManager 仍为清理与槽位释放权威。回调核对当前卡片/Socket，Session ID 不允许被另一个值覆盖，迟到结束/错误/停止超时不能影响替代会话；仅服务端确认清理后允许显式一次性重连。保留原多画面、群控、20 路及页面接口，旧 Node VM fixture 已注入真实新控制器执行集成回归；新增独立生命周期/诊断隔离测试和精确静态资源白名单。最终代码 [a205512](https://github.com/CiBeDerORG/EasyADB/commit/a2055120185c823bcc6065ddabc372221ee70d9a)，[CI #39461806736](https://github.com/CiBeDerORG/EasyADB/actions/runs/39461806736) success。真实环境验收仍待 V2-F10。 |
| V4-04 | P0 | [x] | **MultiView 职责拆分**：新增 `features/live/live-batch-scheduler.js`（启动队列、批量代次、并发预算与完成回调）、`live-card-view.js`（画面容器、宽高自适应、会话诊断与悬浮日志 DOM）、`live-quality-settings.js`（设备画质 Map、wire payload、实验性分辨率及参数弹窗），通过 `app/main.js` 单次 ES Module 装配注入。首次使用懒装配，继承页面已有画质选项与服务器下发 `max_starting`；保留原字段兼容代理及旧 VM 回退，供 V4-05 逐项清理。新增三个精确静态 JS 白名单；旧多画面/20 路 Node 契约已注入真实三个模块，增强了先建页面后装配的数据保留回归。最终代码 [5335af0](https://github.com/CiBeDerORG/EasyADB/commit/5335af034b039346994c6495706d2500e9875a01)，[CI #39464539417](https://github.com/CiBeDerORG/EasyADB/actions/runs/39464539417) success。 |
| V4-05 | P1 | [~] | index.html 的 JS/CSS 与设备管理逐步模块化；保留现有 DOM 约定、交互、五个 dialog 和测试；收紧旧文件 lint/format 豁免。 |
| V4-06 | P0 | [ ] | 全量 Python/Node/Shell/OpenWrt + V2/V4 门禁，实机项目明确待 V2-F10/单独验收，不以 Mock 替代。 |

## 当前停点

- **已完成：V4-01～V4-04**；V4-04 最终代码 `5335af0`、CI #39464539417 success。下一停点 **V4-05**（`index.html`、CSS 和设备管理逐项模块化），V4-05 已开始：先迁移现有 CSS 至精确白名单资源，不做视觉改版；设备展示分组模型已拆出纯函数模块，生产与预装配兼容回退分别保留。待 CI 复核，V4-06 未开始。
