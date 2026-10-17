# EasyADB · 最小连接测试

当前版本只提供：通过 Web 连接一台已授权的无线 ADB 手机，并显示手机当前截图（手动刷新，**非实时投屏**）。首次使用可输入手机显示的六位配对码完成配对。不提供远程触控、自动化或 Agent。

## FNOS / Linux Docker 启动

```sh
cp .env.example .env
# 编辑 .env：将 EASYADB_TOKEN 改为至少 12 位的随机字符串。
# 默认仅监听本机。若需在 EasyTier / LAN 可信网络访问，把 EASYADB_BIND_IP 改为 NAS 相应接口 IP。
docker compose up -d --build
```

浏览器访问 `http://<NAS-IP>:8765`。如果保留 `EASYADB_BIND_IP=127.0.0.1`，需在 NAS 本机打开 `http://127.0.0.1:8765` 或使用 SSH 隧道。页面的「访问密钥」填写 `.env` 中的 `EASYADB_TOKEN`。**不要将管理端口直接暴露到公网。**

1. 手机进入「开发者选项 → 无线调试」，保证运行 EasyADB 的主机能通过现有网络访问手机的 IP 与端口。
2. 首次连接先打开「使用配对码配对设备」。在 Web 页面填写手机 IPv4、**配对弹窗端口**及六位配对码，点击「执行配对」。
3. 回到手机无线调试主页，把显示的**连接端口**填入页面，点击「连接并截图」。
4. 连接成功后可手动点击「刷新截图」。

注意：配对端口和连接端口不是同一个。ADB 授权密钥持久化于 `./data/adb`，请勿提交或分享。手机系统无线调试关闭、端口改变后，应使用实际新端口重新连接。

## 通过现有 Mihomo 加速构建（非 Host 模式）

运行中的 EasyADB 连接现有外部 Docker 网络 `proxy-net`。构建使用独立的 `easyadb-proxy` Buildx `docker-container` 构建器，构建器本身也接入 `proxy-net`；不使用 Host 网络、不新建 Mihomo、不映射其 7890 端口。仅 Dockerfile 中的 apt/curl/pip 等下载及构建器自身访问镜像源使用代理；ADB 到手机仍按现有网络路由连接。

**为什么 Compose 中没有 `build.network: proxy-net`？** 该字段表示 Dockerfile `RUN` 的网络模式，BuildKit 只支持 `default`、`host`、`none` 等模式，直接指定用户自定义网络名可能报 `network mode "proxy-net" not supported by buildkit`。因此由 `scripts/build-with-mihomo.sh` 创建一个连接 `proxy-net` 的专属构建器，不更改其他项目的默认构建器。

1. 确认 `mihomo` 容器已在 `proxy-net` 中，`mixed-port: 7890`，且允许该桥接网络内的代理请求（如 `allow-lan: true` 和 `bind-address: '*'`）。不要向公网开放 7890。
2. 首次创建 `.env`，设置至少 12 位的随机 `EASYADB_TOKEN` 和 Web 访问 IP。推荐让 `EASYADB_BUILD_PROXY` 留空；脚本会在每次启动时自动发现 Mihomo 在 `proxy-net` 的实际 IP，避免 BuildKit 构建步骤中自定义网络 DNS 的兼容问题。
3. 在 EasyADB 项目目录运行：

```sh
cp .env.example .env
# 编辑 .env 后执行
sudo sh scripts/build-with-mihomo.sh
```

脚本执行以下动作：检查外部网络和 Mihomo；创建或复用位于 `proxy-net` 的 `easyadb-proxy` Buildx 构建器；对构建器自身设置 HTTP/HTTPS 代理；将同一代理传入 apt/curl/pip 的构建参数；执行 `docker buildx build --load -t easyadb:local`，最后用 `docker compose up -d --no-build` 启动。

已有 `easyadb-proxy` 构建器若记住了旧的 Mihomo IP，脚本会报告配置不匹配而停止。检查该构建器没有其他用途后，可以执行 `sudo docker buildx rm easyadb-proxy`，再运行脚本重建；不会自动清理其他项目的 Buildx 配置。

**基础镜像和 BuildKit 镜像下载要分开看：** 构建器运行后拉取 `python:3.12-slim-bookworm` 可以使用构建器的代理环境；但首次创建构建器时，`moby/buildkit` 镜像由 Docker Daemon 自行拉取，仍受 Docker Daemon 镜像加速源影响。如果 FNOS 的 Docker 继续访问 `docker.ketches.cn` 并返回 502，须先移除失效的镜像加速源，并根据 FNOS 实际情况为 Docker Daemon 配置单独的代理。不要将 `http://mihomo:7890` 直接写入 Daemon 代理：Daemon 不在 `proxy-net` 中，无法保证解析此容器名称。修改 Docker Daemon 前先备份，重启可能影响其他容器。

注意：普通 `docker compose up -d --build` 不会自动选中专属构建器。需要代理构建时，请使用 `sudo sh scripts/build-with-mihomo.sh`；如只启动已经构建的镜像，可用 `sudo docker compose up -d --no-build`。

---

## 检查

```sh
docker compose logs --tail=100 easyadb
docker compose exec easyadb adb version
```

如果通过 EasyTier 访问异地手机，请先检查子网代理/回程路由、手机所在 LAN 与防火墙。EasyTier 节点在线不代表 ADB 端口一定可达。此最小版本一次仅展示一台手机。

离线模拟测试（需有 Python、FastAPI、httpx 和 pytest）：

```sh
EASYADB_TOKEN=local-test-token-123 python -m pytest -q
```
