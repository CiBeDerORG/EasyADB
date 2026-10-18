# EasyADB · M2 Web 实时控制（开发中）

**M2 在已完成的 M1 上继续开发；M2-00-D 的 PJZ110 真机视频编码链路已经通过。M2-00-E HTTP + NAS IP 的 MSE 实时视频首版已获 PJZ110 基本观看验证，仍需长期稳定性/不同网络条件验收。** 原多设备管理、手动选择组网/内网 IP、首次配对和手动连接规则不变（仅移除截图前端入口，后台截图 API 仍保留）。scrcpy-server 固定官方 v5.0.1，基础档最大边 1600 / 8 Mbps / 30 FPS，原生档不限制尺寸 / 16 Mbps / 30 FPS。在设备投屏工作区勾选任意 1～4 台已连接设备并点击「开始同屏」后，服务端按设备独立将 H.264 通过 FFmpeg 仅转封装（不重新编码）为分片 MP4，经同源 WebSocket 送至各自浏览器 MediaSource 播放；各画面可分别停止，或点击「停止全部同屏」、关闭页面结束本轮会话，不后台重连，不尝试其他 IP。M2-01-A 的正式会话已获 FNOS 验收；M2-02-A 单指触控代码已实现、真机验收暂缓；M2-03-A 已加入需手动开启的远程控制（单指触控、专用输入框 ASCII 文本、返回/主页/最近任务/回车/退格），仍待 CI 与 FNOS 真机验收。不支持中文输入法、全局键盘捕获、声音及录屏。M2-04-A 已加入统一停止和清理确认：停止时取消仍按住的手指，且只有控制/视频/本轮 ADB 资源清理成功，才会发出 `cleanup_complete=true` 并释放设备会话槽；代码待 CI/FNOS 验收。M2-04-B 另增加对当前 WebSocket 的诊断回执存活检测（45 秒宽限）、网络写入超时和网页 pagehide/offline 停止处理；只服务于用户已手动开启的投屏，不会后台探测或自动重连，待 CI/FNOS 验收。M2-04-C 补充当前 scrcpy 媒体/控制链路异常后的单次 ADB 状态确认；仅在明确掉线时清除当前选中地址的连接缓存，网页只刷新现有设备状态，不会自动连接或切换 IP，待 CI/FNOS 验收。当前产品只支持一个正在使用的网页客户端；不开发多浏览器并发/接管，M2-04-D/E/F/G 均按用户要求跳过，不再开发。M2-05-A 增加实时画面省流档（960 / 3 Mbps / 24 FPS）和白名单自定义分辨率上限、目标码率、最高帧率，保留原基础/原生档且默认不变；设置只在新一轮手动投屏时生效，原限时视频实验不变。代码待 CI/FNOS 验收。M2-05 后续已加入浏览器侧实测渲染 FPS、掉帧、缓冲、流量、本地 FFmpeg/ADB Shell 进程 CPU/RSS，以及最近八轮内存画质对照与只读降档提示；真实手机到屏幕的端到端延迟尚需同步时间戳或外部实测。M2-06 已在**同一个网页**加入手动勾选任意 1～4 台设备的同屏网格：仅启动所选设备，不要求全选或至少两台，每台独立画质（省流/基础/原生/自定义）、预检/视频实验、运行日志、MSE/流量/资源诊断、WS/MSE/Session/控制与状态，支持单路停止、全停；服务端最多保留四个不同设备会话槽。原“设备截图”整块区域及隐藏的旧单设备投屏脚本已彻底移除，首页进一步改为顶部访问配置 + 全宽横向独占行设备管理（独立画质嵌入每台设备行、启停按钮集中在设备管理页头）+ 下方全宽大尺寸实时画面；设备列表的手动连接、地址切换、编辑、分组和首次配对保留，原截图 API 不再提供首页入口。不开发多浏览器接管。针对同屏明显卡顿和第二路远控按钮不可用，已准备集中修复：控制通道就绪后不再等待第二路视频 playing；失败解除按钮等待状态；同屏独立默认省流（960 / 3 Mbps / 24 FPS）、等待前一路完成视频初始化后依次启动，并为多路 MSE 合并已排队的完整分片以减少追加开销。保留单设备默认画质与手动连接规则。两模块仍待本轮集中 CI 和 FNOS 双机、四机实测，不能保证所有 NAS/网络条件下的流畅度。澎湃 OS 3 兼容排查：可投屏但不能远控时，先按 scrcpy 官方 FAQ 在手机开发者选项启用独立的「USB 调试（安全设置）」并重启，再用导航“主页”和单指触摸分别验证；网页已增加本轮 Android 拒绝 `INJECT_EVENTS` 的安全分类提示（不回传原始日志）。每台设备可单独启用默认关闭的「低延迟播放实验」，只对浏览器已缓存画面短暂使用 1.15 倍速追近实时前沿，不修改 ColorOS 默认播放路径，也不声称能解决手机编码端的全部延迟。追加同屏已改为按设备隔离：A/B 投屏中可继续新增设备、创建新分组并手动连接 C，勾选 C 后设备管理页头显示「追加投屏」，只启动新勾选的 C，不中断已有视频、远控和画质；同时最多四路，同一设备不会重复创建会话。为避免串号，已运行/待清理的设备自身不能中途修改连接地址、重新连接、编辑或删除；包含运行中设备的现有分组也暂不能修改或删除。设备管理的每台设备行现有独立「实时画面」状态和开启／关闭按钮：无需预先勾选其它设备，可直接开启本台；停止只操作本台，停止中等待服务端清理，支持取消尚未启动的排队项，仍保留页头批量启停以及最多四路限制。静止画面恢复偶发卡顿按此前约定暂缓，本项不改视频编码及 MSE 播放机制。设备管理里暂时隐藏「能力预检 / 视频实验·基础 / 视频实验·原生 / 检测记录」的前端显示，但不删除原 API 或实时画面卡内诊断；每台设备的画质改为独立设置分辨率上限（960/1280/1600/不限制）、目标码率（2/3/4/8/12/16 Mbps）、最高帧率（15/24/30 FPS），默认 960/3 Mbps/24 FPS，只有该设备下一次明确开启投屏时生效，运行中不允许热切换。详情见 [M2 开发记录](docs/M2.md)。

## FNOS / Linux Docker 启动

初次安装可用 `cp .env.example .env` 创建配置并填写随机 `EASYADB_TOKEN`、绑定 IP 和 Mihomo 认证代理；**已部署用户切勿覆盖现有 `.env`**。首次从 M1 / MVP 升级到 M2 时，需要先以原 Git 登录用户（不要对 git 使用 sudo）手动切到 M2，防止旧 M1 自动更新脚本再次切回 M1：

```sh
cd /vol3/1000/software/EasyADB
git fetch origin
git switch --track origin/feat/m2-web-control
# 如果本地已存在分支，改用 git switch feat/m2-web-control
git pull --ff-only origin feat/m2-web-control
sudo sh scripts/build-with-mihomo.sh
```

首次切换后仅需反复执行 `sudo sh scripts/build-with-mihomo.sh`。它会在 Docker 构建前自动以原登录用户身份执行 `git fetch origin`、切换至 `feat/m2-web-control`、`git pull --ff-only`，然后**重新加载刚更新的脚本**执行 Mihomo Buildx 构建及 Compose 覆盖部署。若检测到本地 Git 修改、未跟踪文件或分支无法快进，则停止且不覆盖文件；`.env`、`data/`、`.cache/` 属于忽略项，原样保留。

### 两种部署模式（默认 Mihomo；可显式关闭）

保持原命令不变时，继续使用既有的 Mihomo、`proxy-net`、认证构建代理与专用 `easyadb-proxy` Buildx：

```sh
sudo sh scripts/build-with-mihomo.sh
```

在 OpenWrt 等已由宿主机 / Docker 网络统一处理外网访问的环境，可**显式指定不配置 EasyADB 自身代理**：

```sh
sudo sh scripts/build-with-mihomo.sh --no-proxy
```

`--no-proxy` 路径不读取 `EASYADB_BUILD_PROXY`，不检查 `mihomo` 或 `proxy-net`，不初始化专用 BuildKit 构建器，不设置代理构建参数及临时 `mihomo` 主机名；使用 Docker 默认构建链路和独立的 `compose.no-proxy.yaml`（只加入普通 Compose 网络）。此选项**不强行绕过 OpenWrt、Docker daemon 或系统本来已有的代理/透明转发**，也不自动创建外网连接；需保证 Docker 可以访问 Docker Hub、Debian、Google Android 平台工具和 PyPI。无代理模式无需提前创建 `proxy-net`。

两个模式使用同一 Compose 项目目录、镜像名 `easyadb:local`、`EASYADB_BIND_IP/EASYADB_PORT`、`EASYADB_TOKEN`、设备数据库 `./data/storage` 和 ADB 授权 `./data/adb`。构建成功后覆盖更新既有服务，不执行 `down -v`，也不会删除先前的 Mihomo 或 Buildx。需要恢复代理模式时再次运行不带参数的原命令即可。

**从尚未支持该参数的旧版脚本首次切换至无代理模式时**，先在当前 M1 项目目录（原 Git 登录用户身份，**不要加 sudo**）手动切换至 M2 并获取新脚本，**不能在仍位于 M1 分支时直接 pull M2**：

```sh
cd /vol3/1000/software/EasyADB
git status --short
git fetch origin
git switch feat/m2-web-control 2>/dev/null || git switch --track origin/feat/m2-web-control
git pull --ff-only origin feat/m2-web-control
sudo sh scripts/build-with-mihomo.sh --no-proxy
```

之后每次直接执行带 `--no-proxy` 的命令即可；自动 Git 更新后会透传这一参数，不会重新落回 Mihomo 模式。无效参数和 `--help` 均在 Git/Docker 操作前处理。

继承的 M1 页面按分组折叠展示（未分组单独展示）；「＋ 添加分组」或分组「设置」可填写可选内网 IP 前缀，设备添加弹窗只需填写组网 IP、端口等。设备卡片在每个可用 IP 后有切换按钮；选中地址保存到数据库，并且只有点击「连接」才会发起该地址的 ADB 连接。修改分组前缀会动态更新派生内网 IP，若移除前缀则自动恢复选择组网 IP（但不进行连接）。

浏览器访问 `http://<NAS-IP>:8765`。如果保留 `EASYADB_BIND_IP=127.0.0.1`，需在 NAS 本机打开 `http://127.0.0.1:8765` 或使用 SSH 隧道。页面的「访问密钥」填写 `.env` 中的 `EASYADB_TOKEN`。**不要将管理端口直接暴露到公网。**

1. 手机进入「开发者选项 → 无线调试」，保证 EasyADB 能通过现有网络访问手机 IP 和端口。
2. 首次连接在「＋ 添加设备」弹窗中展开「第一次连接？先配对无线调试」，填写手机 IPv4、**配对弹窗端口**及六位配对码。
3. 在同一弹窗中填写名称、分组，以及手机无线调试主页显示的**连接端口**，保存设备。
4. 在顶部全宽设备管理的对应设备整行点击「连接」，完成手动 ADB 连接。原“设备截图”面板已移除，不再有「查看 / 刷新截图」按钮。
5. 在每台设备整行内勾选任意 1～4 台已连接设备，分别设置画质或点击该设备的能力预检 / 基础 / 原生视频实验；在设备管理页头点击「开始投屏」仅启动所选设备，画面在设备管理下方独占宽区域，支持逐台控制、独立停止和日志查看。运行中可新增并手动连接其它手机，勾选后点击「追加投屏」仅为新增设备启动，不会重启原有视频和远控；同时最多四路。也可在单台设备行查看实时画面状态并直接点击「开启此设备画面」或「关闭此设备画面」，不会连带操作其它设备。点击「停止全部投屏」等待清理确认后，旧画面会被移除；保持勾选可手动再次开始，不会创建重复窗口。受信任内网的 HTTP + NAS IP 可用支持 H.264 MP4 的 Chrome/Edge 播放，无需 HTTPS/WebCodecs；这批新布局仍需 FNOS 真机验收。首次更新 Docker 镜像需安装 FFmpeg，下载的官方 scrcpy v5.0.1 文件继续校验 SHA-256 并附许可证。

注意：配对端口和连接端口不是同一个。ADB 授权密钥持久化于 `./data/adb`，请勿提交或分享。手机系统无线调试关闭、端口改变后，应使用实际新端口重新连接。

## 通过现有 Mihomo 加速构建（proxy-net，含首次 BuildKit 引导）

**M2 分支首次检出后，每次只需一个命令（自动拉取最新 M2）：**

```sh
sudo sh scripts/build-with-mihomo.sh
```

脚本检查现有 `proxy-net` 与 `mihomo`，并在首次缺少 `moby/buildkit:buildx-stable-1` 时自动调用 `scripts/bootstrap-buildkit-via-mihomo.sh`。后者使用官方 `crane` 从 Docker Registry 经 Mihomo 下载镜像 tar 包，再用 `docker load` 本地导入；**不会修改 FNOS 的 daemon.json、重启 Docker，也不依赖已失效的 docker.ketches.cn 镜像加速源**。官方 crane 发布包会与同一发行版的 `checksums.txt` 核对 SHA-256 后使用（默认 v0.22.1）。<https://github.com/google/go-containerregistry/tree/main/cmd/crane>

**两个代理地址的区别：** FNOS 宿主机不在 `proxy-net` 的 Docker DNS 中，所以只在一次性 bootstrap helper 中临时读取 Mihomo 的 *桥接 IP*，供宿主机 curl/crane 直接代理下载。EasyADB 与 BuildKit 构建器真正运行后，都加入 `proxy-net`，**始终使用 `http://mihomo:7890` 这个容器名**，不会把临时 IP 保存到配置。

`.env` 中填写 Mihomo 代理 URL（主脚本和首次下载 BuildKit 的辅助脚本会自动读取，使用 `sudo sh` 也不需要手动 `export`）：

```ini
# Mihomo 没有认证时
EASYADB_BUILD_PROXY=http://mihomo:7890
# 如果启用了认证，请改为这种形式：
# EASYADB_BUILD_PROXY=http://用户名:URL编码后的密码@mihomo:7890
# 例如密码 abc@mihomo → abc%40mihomo
```

不要将真实 `.env` 提交到 GitHub。脚本不会主动打印完整代理 URL，但代理凭据可能保存在 BuildKit 构建器的 Docker 配置中，且具有 Docker 管理权限的人可以读取。

检查 Mihomo 已加入 `proxy-net` 且允许同网络访问 `mixed-port: 7890`（如 `allow-lan: true`、`bind-address: '*'`）；不要把代理端口开放到公网。首次下载需 FNOS 自带 `curl`、`tar`、`sha256sum` 和可用的系统 CA 证书；目前 helper 支持 Linux amd64 / arm64。大体积的下载文件保存在仓库 `.cache/`（完成后自动清理），磁盘紧张可通过 `EASYADB_BOOTSTRAP_CACHE` 指定其他目录。**若 FNOS 的 `/vol3` 数据卷设置了 `noexec`**，脚本会依次检测 `/tmp`、`/var/tmp`、`/root` 是否真正允许运行临时二进制文件，Crane 仅解压到通过检测的临时目录，避免在 `.cache` 直接执行时报 `Permission denied`。如均不可执行，可指定已存在的可写、可执行目录：`sudo EASYADB_EXEC_TMP=/path/on/exec/filesystem sh scripts/build-with-mihomo.sh`。不需要修改数据卷挂载参数。

还可以只验证一次性镜像引导，不启动 EasyADB：

```sh
sudo sh scripts/bootstrap-buildkit-via-mihomo.sh
sudo docker image inspect moby/buildkit:buildx-stable-1
```

随后主脚本使用专属 `docker-container` Buildx 构建器 `easyadb-proxy`，以 `--driver-opt network=proxy-net` 加入既有网络；构建器自身的 HTTP/HTTPS 代理及 Dockerfile 中的 apt/curl/pip 下载代理均为 `http://mihomo:7890`。构建时使用 `--load`，最后通过 `docker compose up -d --no-build` 启动服务；不更改其他项目默认构建器。如果之前失败留下一个没有容器的同名 EasyADB 构建器，主脚本会仅清理这个项目专用的残留构建器。

**注意：** `build.network: proxy-net` 不能代替这套做法；它控制 Dockerfile 中 RUN 的网络模式，不等同于构建器容器所在的自定义 Docker 网络。正常启动请使用主脚本，而不是裸跑 `docker compose up --build`。

---

### 遇到 HTTP 407：代理要求认证

如 Mihomo 开启了代理账号密码，请在 **EasyADB 项目根目录的 `.env`** 中设置：

```ini
EASYADB_BUILD_PROXY=http://用户名:URL编码后的密码@mihomo:7890
```

例如密码为 `abc@mihomo`，应当写成 `abc%40mihomo`（`@` 必须为 `%40`；如包含 `#` 写为 `%23`）。**用户名与密码中的其他 URL 保留字符也需编码。** 脚本不对 `.env` 执行 shell source/eval；它只读取 `EASYADB_BUILD_PROXY` 字段，不会主动打印该 URL。

更新代码后在项目目录执行：

```sh
git pull --ff-only origin feat/m2-web-control
sudo sh scripts/build-with-mihomo.sh
```

若仍有 407，先确认 `.env` 没有保留无认证的 `http://mihomo:7890`，检查账号密码是否对应**代理 mixed-port** 而非 Dashboard API 的 secret。Mihomo `external-controller-cors` / trusted Web origins 与 7890 代理认证无关；不需要关闭认证或添加网段豁免。已配对但出错也可能是上游代理的认证问题，请检查 Mihomo 的实际出站配置。

---

### 如果基础镜像成功，但 apt 报 `Temporary failure resolving 'mihomo'`

这是 BuildKit 的 Dockerfile `RUN` 沙箱不能自动继承 `proxy-net` 的 Docker DNS，不代表 Mihomo 代理密码错误。脚本现在在执行 `docker buildx build` 时动态查询 Mihomo 的 `proxy-net` IPv4，注入临时参数 `--add-host "mihomo:<当前IP>"`，只对本次构建步骤创建名称映射，不修改 `.env`、`daemon.json` 或 FNOS Host 网络，也不会把 IP 固定写入镜像配置。这个参数来自 Docker 官方 Buildx 接口。

需要更新 EasyADB 开发分支后继续执行原来的 `sudo sh scripts/build-with-mihomo.sh`。无需重新下载已缓存的 BuildKit/Python 镜像；如果后续出现连接超时而非域名错误，再检查 FNOS 的 Docker 桥接网络之间是否允许 TCP 访问 Mihomo 的 7890 端口。直接 `docker compose up --build` 不经过此脚本，不会自动添加该主机名映射。

---

### 如果已经导入 BuildKit，但拉取 Python 基础镜像时 `auth.docker.io` 超时

Docker Hub 的匿名令牌请求可能由宿主机的 Buildx CLI 发起，不完全由 BuildKit 容器处理。主构建脚本现已同时设置三处代理：

- FNOS 宿主机的 Buildx CLI：使用 Mihomo 在宿主机可访问的桥接 IP，并保留 `.env` 中认证信息；
- `proxy-net` 中的 BuildKit 容器：使用 `mihomo:7890`；
- Dockerfile 的 apt/curl/pip 下载：通过构建代理参数使用 `mihomo:7890`。

如果错误日志中出现 `Driver Options: ... env.HTTPS_PROXY=...`，说明旧版 `buildx inspect --bootstrap` 曾将代理密码直接打印到终端。请更换 Mihomo 的代理密码，再修改项目本地 `.env`；新主脚本不再输出该 inspect 内容，若项目专属构建器仍保存旧密码，会自动重新创建它。**不要粘贴完整 `docker buildx inspect easyadb-proxy` 或 `docker inspect buildx_buildkit_easyadb-proxy0` 输出，它们可能包含代理凭据。**

更新并重新运行：

```sh
git pull --ff-only origin feat/m2-web-control
sudo sh scripts/build-with-mihomo.sh
```

---
 
## 检查

```sh
docker compose logs --tail=100 easyadb
docker compose exec easyadb adb version
```

如果通过 EasyTier 访问异地手机，请先检查子网代理/回程路由、手机所在 LAN 与防火墙。EasyTier 节点在线不代表 ADB 端口一定可达。M1 仍可保存和管理多台手机；现行首页不再提供旧截图面板，实时视频在全宽设备管理下面的大尺寸独立画面卡片中展示。

离线模拟测试（需有 Python、FastAPI、httpx 和 pytest）：

```sh
EASYADB_TOKEN=local-test-token-123 python -m pytest -q
```
