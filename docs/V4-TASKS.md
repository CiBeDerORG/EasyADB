# EasyADB V4 · 前端架构与规范化重构任务

> 独立分支：refactor/v4-frontend-standards；基线 V2 HEAD 6221766994c5e5447d7e293b53ce079aee1c64dc（Actions #39451874696 success）。V3 暂缓；V2-F10 真实环境验收尚未执行。本计划不合并 M4 映射分支，不开发新业务。

## 执行规则

- 复杂任务每轮**仅执行一项**；简单且相互独立的任务每轮最多执行连续两项，必须分别提交及验证；收到“继续”才进入下一轮。
- 每项代码与定向测试独立提交，完整旧 CI+新增门禁通过后再单独更新进度；复核最新 HEAD 的 CI，未验证不得打钩。失败时只修当前项。
- 新增代码遵循 [前端命名与架构规范](V4-FRONTEND-STANDARDS.md)；旧 IIFE、内联 HTML/CSS 不批量改名/格式化，兼容豁免随着逐项迁移收紧。
- 不更改外部 REST/WS 协议、数据库、V2 SessionManager、DIRTY 资源所有权、20 路逻辑上限、WebRTC-only 或页面交互；不执行 FNOS/NAS/Docker/Android/OpenWrt/EasyTier 真实部署。

| ID | 优先级 | 状态 | 最小交付与验收 |
| --- | --- | --- | --- |
| V4-01 | P0 | [ ] | 前端架构/命名/CSS/生命周期标准；EditorConfig、ESLint、Prettier 与独立 V4 CI 门禁；保留逐文件历史豁免，新代码自动受检，不修改原业务脚本。 |
| V4-02 | P0 | [ ] | 公共 API Client、DOM、Toast、Dialog 逐项迁移到显式模块，补现有静态资源路由/Node VM 兼容契约，禁止新增 window 全局业务入口。 |
| V4-03 | P0 | [ ] | 单路 LiveSessionController 拥有本轮 WS/WebRTC/Touch/诊断的前端生命周期；旧 session_id 回调不能释放新会话；全量停止回归。 |
| V4-04 | P0 | [ ] | MultiView 拆出 LiveBatchScheduler/LiveCardView/画质配置，维持服务器下发并发配额、设备选择和批量停止语义。 |
| V4-05 | P1 | [ ] | index.html 的 JS/CSS 与设备管理逐步模块化；保留现有 DOM 约定、交互、五个 dialog 和测试；收紧旧文件 lint/format 豁免。 |
| V4-06 | P0 | [ ] | 全量 Python/Node/Shell/OpenWrt + V2/V4 门禁，实机项目明确待 V2-F10/单独验收，不以 Mock 替代。 |

## 当前停点

- V4-01 执行中；V4-02～V4-06 未启动。每轮按上面的复杂度规则推进。
