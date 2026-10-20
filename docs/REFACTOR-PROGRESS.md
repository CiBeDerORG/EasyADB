# EasyADB V1 架构重构进度（唯一接续入口）

**状态（2026-10-20）：V1 代码改造完成，自动化验收通过；真实 NAS / 安卓 / OpenWrt 环境尚待人工实机验收。** 分别记录这三种状态，避免把 Mock 测试误称为真机通过。

## 固定范围

- 唯一源业务基线：`feat/m3-openwrt-discovery`，起点 `5ff047fa3a4dbe0aed75e1a06fa0d4d20042787a`。
- 唯一 V1 工作分支：`refactor/foundation-v1`，没有改写源 M3 或 main。
- **严格排除 `feat/m4-screen-mapping-m1`，没有引入画面映射的实现或需求。**
- 完整目标和不可破坏的安全/行为契约见 [架构报告](REFACTOR-ROADMAP.md)。实机核验步骤见 [V1 验收清单](V1-ACCEPTANCE.md)。

## V1 最终代码与自动化状态

| 编号 | 状态 | 交付与证据 |
| --- | --- | --- |
| V1-01 回归基线和 CI | **完成，CI 通过** | M3 HTTP 请求方法/路径、WS 反向路由与握手、鉴权、静态资源请求契约；重构分支接入测试工作流 |
| V1-02 配置和初始化 | **完成，CI 通过** | `core/config.py`、`core/runtime.py`、`core/lifecycle.py`；原 `.env` 语义保留；显式 SQLite 初始化和原有 Session 清理；模块别名保留测试注入兼容 |
| V1-03 拆分主入口 | **完成，CI 通过** | `api/static.py`、`api/{groups,devices,lab,live,legacy}.py` 路由声明；`api/{schemas,validation}.py`；视频 WS `api/live_handler.py`，副屏实验 `api/lab_handlers.py`；旧接口 `api/legacy_handlers.py` 和截图 `api/screenshots.py`；`app.py` 从约 1456 行缩至约 406 行，剩余薄兼容 Facade、装配、鉴权和 ADB 入口 |
| V1-04 Service/业务异常 | **完成，CI 通过** | `core/exceptions.py`；`services/{device_service,device_control,group_service,group_discovery,pair_service,preflight_service,live_coordination}.py`；领域错误在 API 兼容 Facade 映射为原有 HTTP 状态码；没有重写原底层 `DeviceManager` / scrcpy |
| V1-05 协调锁与并发 | **完成，CI 通过** | `services/operations.py` 复用已有设备 RLock；组操作锁 → 成员关系锁 → 排序去重设备锁 → 会话注册表锁；组扫描先持组锁再读组状态，保留设备在线/投屏时不覆盖端口；专项测试覆盖在途扫描、跨设备不阻塞和原有并发行为 |
| V1-06 完整自动化回归 | **完成，CI 通过** | 最新业务提交 `360a3aa329200ff6c2a1ad265b32a8e4dba9e3dc` 的 [Actions #39421665657](https://github.com/CiBeDerORG/EasyADB/actions/runs/39421665657)：**215 passed，1 warning**；Python、编译、Node/页面及 Shell 部署脚本、OpenWrt ACL/扫描烟测全部成功；既有 SQLite 数据保留专项测试通过 |

**未宣称的验证：** 尚未在用户真实 FNOS NAS、Mate30/其他安卓手机、实际 OpenWrt+EasyTier 网络中运行升级和长时稳定性/性能验证。20 路会话数量的代码/契约上限不等于 20 台真机同屏性能；后续 V2 的资源预算和压力测试独立处理。

## 关键阶段及 CI 记录

| 提交 | 内容/结果 |
| --- | --- |
| `b69bd2b`、`e9a6d19` | M3 基线与早期重构回归，209 passed |
| `39eb7ec` | 组成员/设备锁顺序修复，通过 |
| `253f071`、`2017daf` | HTTP/WS 契约测试适配、并发测试，通过 |
| `c10d2eb`、`9ecbdf5`、`803264c` | 设备 CRUD、生命周期、分组 Service，通过 |
| `cd9cd94`、`f3cf415`、`f754141` | WS Handler、请求 Schema、CastPlus 实验模块拆分，通过 |
| `8fe4e20` | 路线/解锁/显式连接控制 Service；[CI #39412226506](https://github.com/CiBeDerORG/EasyADB/actions/runs/39412226506) 212 passed |
| `d4e8645`、`f227e3d`、`255f534` | 扫描竞态修复、配对/M2 显式探测 Service；原 private 仓库因 Actions 计费限制导致 Runner 不分配，**转 Public 后重跑** [#39412844047](https://github.com/CiBeDerORG/EasyADB/actions/runs/39412844047) 成功：213 passed |
| `ef13cf2` | 分离旧接口、截图、视频断线/Peer 清理， [CI #39421582230](https://github.com/CiBeDerORG/EasyADB/actions/runs/39421582230) 成功 |
| `360a3aa` | 新增不同设备互不阻塞、已有 SQLite 数据保留回归，[CI #39421665657](https://github.com/CiBeDerORG/EasyADB/actions/runs/39421665657) 成功：**215 passed，1 warning** |

### 已解决的 CI 阻塞

GitHub 私有仓库在提交 `d4e8645` 后出现 Runner 分配前失败（`runner_id=0`、`steps=[]`）。Actions 页面标注“recent account payments have failed or your spending limit needs to be increased”；仓库调整为 Public 后，原 HEAD `255f534` 的第 2 次运行成功启动真实 Runner 并执行测试。**不是 Python 代码错误，不再是当前 V1 的阻塞项。**

## 保留的兼容与安全边界

1. 不启动后台 ADB 探测/自动连接、OpenWrt 隐式扫描或新心跳；只有用户显式连接、扫描或打开实时画面才触发相应操作。
2. 旧 `/api/connect` / `/api/status` / `/api/screenshot` 与以设备 ID 为中心的 M1/M2 API 分离；外部端点、鉴权和响应保持原样。
3. WS 维持同源限制、首消息 token 认证、Session ID 绑定、清理未确认时不复用，会话和 ADB/视频状态仍由同一实例持有。
4. 设备选中线路不隐式切换；锁按稳定顺序进入；不同设备无需等待另一个设备的 per-device 锁。
5. 原 SQLite 表/数据及部署变量不静默迁移或清空；本版本不引入 M4、Redis、消息队列、微服务或 V2 资源状态机。
6. 模块级兼容名称保留给现有测试的 monkeypatch/旧客户端；`app.py` 允许薄 Adapter 而非要求为减行数改变注入和业务行为。

## 下一阶段

代码与 CI 层面的 **V1 关口已通过**；请按 [V1 实机验收清单](V1-ACCEPTANCE.md) 执行真实网络与设备验证。实机通过后再决定是否合并/部署此重构分支；不要直接把 Mock 测试结论当生产部署许可。V2 才处理会话状态机、20 路资源预算和长时负载，其他规划参见路线图。
