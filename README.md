# EasyADB · M2 Web 实时控制（开发中）

**M2 以已完成的 M1 为基础，当前阶段正在实施 M2-00 技术验证，尚未实现实时投屏或远程控制。** 原多设备管理、组网/内网 IP 手动切换、按设备连接、首次配对和手动截图保持不变；不能自动切换线路或自动重连。首批新增「M2 能力预检」：用户手动连接设备后，点击按钮显式获取当前所选地址的 Android SDK、ABI、机型、屏幕信息。只读查询、不安装 scrcpy、不产生视频流，结果明确为 `stream_verified=false`。完整技术路线和验收清单见 [M2 开发记录](docs/M2.md)，已完成 M1 功能见 [M1 文档](docs/M1.md)。

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
4. 在所属分组的设备卡片上点击「连接」「查看」；连接成功后右侧可手动「刷新截图」。
5. M2-00 可在已连接的设备旁点击「M2 能力预检」，显式读取基础设备信息；预检并非实时视频或 scrcpy 兼容性证明。

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

如果通过 EasyTier 访问异地手机，请先检查子网代理/回程路由、手机所在 LAN 与防火墙。EasyTier 节点在线不代表 ADB 端口一定可达。M1 可保存并管理多台手机；当前截图区一次展示一台选中的手机。

离线模拟测试（需有 Python、FastAPI、httpx 和 pytest）：

```sh
EASYADB_TOKEN=local-test-token-123 python -m pytest -q
```
