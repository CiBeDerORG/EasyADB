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
| V4-03 | P0 | [ ] | 单路 LiveSessionController 拥有本轮 WS/WebRTC/Touch/诊断的前端生命周期；旧 session_id 回调不能释放新会话；全量停止回归。 |
| V4-04 | P0 | [ ] | MultiView 拆出 LiveBatchScheduler/LiveCardView/画质配置，维持服务器下发并发配额、设备选择和批量停止语义。 |
| V4-05 | P1 | [ ] | index.html 的 JS/CSS 与设备管理逐步模块化；保留现有 DOM 约定、交互、五个 dialog 和测试；收紧旧文件 lint/format 豁免。 |
| V4-06 | P0 | [ ] | 全量 Python/Node/Shell/OpenWrt + V2/V4 门禁，实机项目明确待 V2-F10/单独验收，不以 Mock 替代。 |

## 当前停点

- **已完成：V4-01、V4-02**；V4-02 最终代码 `485ecc3`、CI #39458266192 success。下一停点 **V4-03**（单路会话控制器，复杂任务），V4-03～V4-06 均未开始；本轮停止。
