# EasyADB V4 改造进度

- 工作分支：refactor/v4-frontend-standards。
- 只在完成对应工作和本提交 CI 后更新。V3 暂缓，V2-F10 真实 FNOS/Android/OpenWrt/EasyTier 验收仍待执行。
- **V4-01 已完成（自动化验收）**：独立分支起点 V2 HEAD `6221766`；代码改造与修复提交依次为 `1a56a7a`、`dc6b2be`、`5ff4702`、`433d031`、最终 [3548925](https://github.com/CiBeDerORG/EasyADB/commit/3548925e1fe0343ff86cd255a7a643e335fdc061)。最终 [CI #39456125975](https://github.com/CiBeDerORG/EasyADB/actions/runs/39456125975) **success**：受支持 ESLint/Prettier 版本及 npm lock、V4 命名/格式/目录门禁、现有 Node UI 契约、完整 Python、Shell 与 OpenWrt 烟测均通过。旧版前端 IIFE 和内联 CSS 仅显式豁免，不改变运行时与 API。
- **V4-02 已完成（自动化验收）**：新增显式 API Client、DOM、Toast、Dialog ES Modules、一次性旧内联适配和精确静态资源白名单。初始提交 `bbc4055`，ESLint 环境修正 `e8ed87f`，最终格式修正 [485ecc3](https://github.com/CiBeDerORG/EasyADB/commit/485ecc34c90929c4e290cb2fd34fde46074d55dc)；[CI #39458266192](https://github.com/CiBeDerORG/EasyADB/actions/runs/39458266192) **success**。原 Python 276 项、Node/静态资源回归、Shell 和 OpenWrt 烟测均通过。真实浏览器/实机验证不以 CI 代替。
- **停点：V4-03**，尚未开始。最新文档提交的 HEAD CI 必须单独复核。
- V3 继续暂缓，V2-F10 真实 FNOS/Android/OpenWrt/EasyTier 验收仍待执行。
