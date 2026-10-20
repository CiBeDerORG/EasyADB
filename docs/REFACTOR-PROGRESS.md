# EasyADB 架构重构进度（持续更新）

此文件是恢复工作的唯一进度入口；完整原因和 V1–V5 规划见 [REFACTOR-ROADMAP.md](REFACTOR-ROADMAP.md)。**已提交、CI 通过、实机验收是三个不同状态，不能混为一谈。**

## 范围与分支

- 唯一业务基线：`feat/m3-openwrt-discovery`，起始 SHA `5ff047fa3a4dbe0aed75e1a06fa0d4d20042787a`。
- 唯一工作分支：`refactor/foundation-v1`。M3 原分支及 `main` 未被本次写入。
- **不考虑 `feat/m4-screen-mapping-m1`**，不合并其任何代码。
- 当前版本：V1 框架根基；尚未整体完成；原有部署配置/API/WS/SQLite 需兼容。
- 进度日期：2026-10-20。后续请以分支最新 HEAD 和 GitHub CI 实际记录为准。

## V1 分项状态

| 编号 | 当前状态 | 本轮实施 | 尚需处理 |
| --- | --- | --- | --- |
| V1-01 基线和 CI | 已实现，代码版 CI 已通过 | 新增固定 M3 的 48 个 HTTP 路径/方法、1 个 WS 路径及鉴权契约；CI 增加本重构分支；静态资源实际 GET 验证 | 本轮代码版 CI 已通过；后续代码变更继续逐次验证 |
| V1-02 配置与初始化 | **部分完成** | 新建 `server/core/config.py` 验证原环境变量；`server/core/runtime.py` 集中构造 SQLite、DeviceManager、发现客户端、LiveRegistry、DisplayLab；保留 app 模块全局兼容别名 | 显式生命周期/依赖注入逐步替代旧全局访问，检查 monkeypatch 和 DB 原位启动 |
| V1-03 拆分 app.py | **部分完成** | 静态首页和 JS 路由拆至 `server/api/static.py`，app 显式 include_router | 设备、分组、发现、实验、媒体 WS 仍在 app.py；先迁移轻量 Router/Service，最后再碰复杂 WS |
| V1-04 Service/异常规范 | 未开始 | 暂不主动修改既有 HTTP 错误语义 | 定义业务错误和 API 映射边界 |
| V1-05 设备操作协调 | **部分完成** | 新增 `server/services/operations.py`，统一复用 DeviceManager 原设备锁；多设备锁按稳定去重顺序获取；app 现有 18 处设备加锁调用统一入口；补齐设备修改/删除同锁，新增阻塞测试 | 分组更新/删除、组成员变更与全局锁顺序仍需专项处理；V2 继续做会话/资源状态机 |
| V1-06 完整回归 | 未开始 | 已补配置不触发 ADB/DB、锁顺序、同设备修改/删除竞争测试 | CI 通过后还需 NAS/安卓/真实 OpenWrt 实机验收；需排除运行环境差异 |

## 本轮提交（均在重构分支）

| SHA 前缀 | 改动 |
| --- | --- |
| `a8e219a` | 架构审核和 V1–V5 改造路线图 |
| `20a5dc5` | 本进度台账初版 |
| `13cfaa8` | 固定 M3 API/WS/鉴权回归契约 |
| `b69bd2b` | CI 纳入重构分支；**该基线提交 CI 已通过** |
| `b1bfa48` | 集中启动配置/运行组件构造，拆分静态 Router |
| `08e3925` | 设备协调入口及排序多设备锁 |
| `77d5507` | 设备基础信息修改、删除进入同设备锁 |
| `3bde34f` | 配置、运行组装及锁竞争专项测试 |
| `8307eab` / `1979453` | 适配 API/静态资源拆分后的原有测试定位 |
| `50ee861` / `e9a6d19` | 校正测试中 Path 类型比较，并用 HTTP 实测静态资源 |

本次实际业务代码的最近提交是 `e9a6d1928eae5a12b7e0c13157d53df1efe9bb23`（后续文档提交不改变业务代码）。其 [GitHub CI](https://github.com/CiBeDerORG/EasyADB/actions/runs/39403779263) **已成功：209 passed、1 warning；编译、前端/部署脚本检查、OpenWrt 烟测和 Python Mock 测试步骤均成功**。这是自动化检查，不代表 NAS/真机性能验收。

## CI 与异常记录

- `b69bd2b`：纯基线及原自动化测试已通过。
- `e9a6d19`：本轮最新业务代码自动化 CI 通过，209 passed / 1 warning；见上方运行链接。
- 初次静态 Router 拆分引发旧 `m2_group_contract.cjs` 按 app.py 固定文本位置定位失败；已改为核对实际静态 Router 与 include_router，**并未改变页面路径**。
- 新增基线测试将静态路由与 API 注册表混测，引发断言错误；改成 API/WS 路径比对 + 静态资源真实 HTTP GET、MIME 与 Cache-Control 验证。
- 新测试一度比较 `DeviceStore.path`（Path）与字符串，已纠正为 Path 比较。
- 以上仅是测试/模块路径适配记录，不将中途红灯视为最终验收通过。查看最新 HEAD 的流水线结论。

## 下次继续的具体步骤

1. 核对重构分支最新 HEAD、进度与最后一次 CI；若失败，先修复，不开始新阶段。
2. V1-02：补应用生命周期/依赖持有方式，并保持现有测试注入兼容。
3. V1-03：按设备 → 分组/发现 → 实验 → 复杂 WS 的顺序迁移 Router；每次迁移都用已有测试验证，不引入新需求。
4. V1-04/05：单独处理分组成员变化与设备锁的全局顺序，覆盖并发和失败路径。
5. 通过 V1-06 完整回归后才能宣布 V1 完成。实机测试与模拟验证分开列示。

## 固定底线

保留认证、同源 WS、Session ID、脏会话不重用、显式 ADB 操作、设备选择线路、不跨设备控制及 SQLite 原数据；不引入 M4 映射。**未经真实 CI/真机验证的成果不得标记验收完成。**
