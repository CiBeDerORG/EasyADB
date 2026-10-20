# EasyADB 架构重构进度（唯一接续入口）

本文件持续记录 **实际已提交代码、CI、待办与阻塞**；总体设计和 V1–V5 规划见 [REFACTOR-ROADMAP.md](REFACTOR-ROADMAP.md)。请不要把自动化模拟测试当作 NAS/路由器/手机实机验收。

## 固定范围

- 源业务分支：`feat/m3-openwrt-discovery`；固定起点 `5ff047fa3a4dbe0aed75e1a06fa0d4d20042787a`。
- 唯一改造分支：`refactor/foundation-v1`；源分支和 main 未被本轮写入。
- **排除 `feat/m4-screen-mapping-m1`**，不合并、分析或验收其映射功能。
- 时间：2026-10-20；读取本文后务必核对 GitHub 最新 HEAD/Actions，以最新实际结果为准。

## V1 分项进度

| 编号 | 状态 | 已实施 | 未完成及判定标准 |
| --- | --- | --- | --- |
| V1-01 基线和 CI | 代码完成，已验证 | 冻结 M3 HTTP 方法/路径、WS 反向路由及鉴权契约；重构分支接入 CI；静态资源执行真实 GET | 后续每次变更继续回归 |
| V1-02 配置/初始化 | 代码完成，已验证 | `core/config.py`、`core/runtime.py`、`core/lifecycle.py`；仅在 lifespan 初始化数据库和停止已有 Session；维持原 app 全局兼容别名，测试可注入 Mock | 真实 NAS 原地启动待实机验收 |
| V1-03 API 与主入口拆分 | **主要完成，余兼容收尾** | `api/static.py`、按设备/分组/实验/实时画面/旧接口分离路由声明；`api/schemas.py`、`api/validation.py`；副屏实验 `api/lab_handlers.py`；约 600 行实时视频协议迁至 `api/live_handler.py`，app.py 从约 1456 行降到约 474 行 | app.py 还保留旧版 HTTP 兼容 Facade、少量 ADB/截图/预检/媒体生命周期辅助函数；不要误称它仅剩装配逻辑 |
| V1-04 Service/异常 | **主要完成，余兼容收尾** | `core/exceptions.py` 的 `DomainError` 在 API 层映射原有状态码；`services/{device_service,device_control,group_service,group_discovery}.py` 均不直接依赖 FastAPI | 追加 `services/pair_service.py` 和 `services/preflight_service.py` 迁出配对、显式 M2 预检/视频实验（最新提交待有效 CI）；M1 既有 `DeviceManager` 和 app 内少量旧兼容实现仍保留 HTTPException |
| V1-05 统一设备协调 | 核心实现已完成，最新竞态修复待 CI | `services/operations.py` 复用原设备 RLock，组操作锁 → 成员关系锁 → 排序后的设备锁 → 会话注册表锁；CRUD、设备组更改/删除、发现端口落库使用统一顺序；额外隔离组发现与 OpenWrt 凭据修改；有并发回归测试 | 最新扫描读配置前先拿分组锁的修复 `d4e8645`、后续配对/预检抽取 `f227e3d` 均需有效 CI |
| V1-06 完整回归 | **待最终提交验收** | `8fe4e20` 完整 CI 通过（212 passed / 1 warning；脚本/编译/ACL 烟测亦绿），含原有实时画面 Mock/WebSocket 测试 | 最新 `d4e8645` 和 `f227e3d` 尚无有效 Runner 结果；NAS/真机/OpenWrt 和真实 20 路另列实机验收，不能冒充自动化已验证 |

## 关键提交（从上次记录继续）

| 提交 | 内容 | CI |
| --- | --- | --- |
| `39eb7ec` | 分组和设备成员变更统一锁序 | 通过 |
| `59b1a83` / `fa06607` | 按领域声明路由、抽离发现业务流程 | 中间的测试实现需适配新路由类型 |
| `253f071` | 修正契约测试为真实外部请求及 WS 路由校验 | 通过 |
| `2017daf` | 补分组编辑与在途发现/设备锁的并发测试 | 后续提交覆盖验证 |
| `c10d2eb` | 设备 CRUD Service | 通过 |
| `9ecbdf5` | 生命周期管理独立于 app 路由 | 通过 |
| `803264c` | 分组 CRUD/发现配置 Service | 通过 |
| `fa3eccb` / `cd9cd94` | 迁出视频 WS Handler 并修正设备锁依赖、解锁测试路径 | 修复后通过 |
| `f3cf415` | 迁出请求模型及参数校验 | 通过 |
| `f754141` | 迁出副屏实验和 CastPlus Handler | 通过 |
| `8fe4e20` | 迁出线路、开屏密码、显式连接/刷新 Service | **通过，212 passed / 1 warning**，运行 [39412226506](https://github.com/CiBeDerORG/EasyADB/actions/runs/39412226506) |
| `d4e8645` | 扫描取得组操作锁以后才读取分组状态，增加对应锁测试 | **待有效 CI**：运行 [39412390166](https://github.com/CiBeDerORG/EasyADB/actions/runs/39412390166) 两次均约 2–4 秒失败，`runner_id=0`、`steps=[]`；无代码测试日志 |
| `65f2f86` | 更新 V1 进度与阻塞记录（文档） | [39412633768](https://github.com/CiBeDerORG/EasyADB/actions/runs/39412633768) 无 Runner、无步骤失败 |
| `f227e3d` | 配对与 M2 预检/视频实验迁入 Service，保留 app 兼容函数 | [39412745663](https://github.com/CiBeDerORG/EasyADB/actions/runs/39412745663) 同样 `runner_id=0`、`steps=[]`，**尚未通过可执行 CI** |

第一批重构和各历史提交参见分支 Git 历史。当前应以 `f227e3dc7df85872775d40455c04d3348c75ea6d` 及后续进度文档提交为基准，不回退到 M3/M4 其他分支。

## 兼容与架构边界

1. 仍以同一个 FastAPI 应用、同一个 DeviceStore/DeviceManager/LiveRegistry 运行，不添加新后台心跳、自动扫描、自动连接、自动投屏。
2. 设备 ID、手选连接线路、既有 HTTP/WS 路径及媒体首消息鉴权不变；未清理完的 Session 绝不提前复用。
3. 现有测试依赖直接替换 `server.app.store/manager/LiveVideo/automatic_unlock` 等变量，迁出 Handler 使用调用时绑定，不创建第二套状态。
4. 多设备锁按唯一 ID 稳定排序；组扫描、组编辑和设备成员关系变更不得颠倒锁序。分组扫描先拿组操作锁，再读取当前组状态。
5. 保留原 SQLite 数据与 `.env`、Docker/部署模式。20 是会话上限，不保证真机 20 路吞吐量。

## 接下来严格按此顺序处理

1. 先排查仓库 Actions 的 Runner 分配/账号用量/平台运行限制，获取可执行的最新提交 CI。自 `d4e8645` 起多次 push/re-run 均 `runner_id=0`、`steps=[]`，未启动 checkout；此状态绝不可表述为测试失败或代码已通过。若恢复 Runner 后测试失败，再根据日志修复。
2. V1-03/04 兼容收尾：对 app.py 仍留存的轻量 ADB/截图、预检和旧兼容接口明确业务所有权；保留外部函数名称与测试注入能力。不要为减行数引入行为变化。
3. 再跑完整 Python/Node/脚本/WS 协议回归；原数据库升级和真实 NAS/Mate30/OpenWrt 联调须另行实机验收。
4. 通过 V1 验收后才能把总体 V1 标记为「完成」并进入 V2 会话状态机。**当前仍是 V1 进行中。**

## 本次停点（最新）

最后一个获得**完整执行**和测试通过的业务提交是 `8fe4e20`：212 passed / 1 warning；之后 `d4e8645` 和 `f227e3d` 已提交但因 Runner 未分配没有有效 CI。重构分支的最新代码以 `f227e3d` 为准，**没有宣称 V1 全部完成**。待 CI 恢复后先回归上述两个代码提交，再做 V1-03/04 少量 legacy Facade 的界面与领域责任收尾；保留 M3 源分支和 M4 排除规则。
