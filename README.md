# EasyADB · 最小连接测试

当前版本只提供：通过 Web 连接一台已授权的无线 ADB 手机，并显示手机当前截图（手动刷新，**非实时投屏**）。首次使用可输入手机显示的六位配对码完成配对。不提供远程触控、自动化或 Agent。

## FNOS / Linux Docker 启动

```sh
cp .env.example .env
# 编辑 .env：设置随机 EASYADB_TOKEN 和 Web 监听 IP。
# 使用现有 proxy-net / Mihomo 构建，不使用 Host 网络：
sudo sh scripts/build-with-mihomo.sh
```

浏览器访问 `http://<NAS-IP>:8765`。如果保留 `EASYADB_BIND_IP=127.0.0.1`，需在 NAS 本机打开 `http://127.0.0.1:8765` 或使用 SSH 隧道。页面的「访问密钥」填写 `.env` 中的 `EASYADB_TOKEN`。**不要将管理端口直接暴露到公网。**

1. 手机进入「开发者选项 → 无线调试」，保证运行 EasyADB 的主机能通过现有网络访问手机的 IP 与端口。
2. 首次连接先打开「使用配对码配对设备」。在 Web 页面填写手机 IPv4、**配对弹窗端口**及六位配对码，点击「执行配对」。
3. 回到手机无线调试主页，把显示的**连接端口**填入页面，点击「连接并截图」。
4. 连接成功后可手动点击「刷新截图」。

注意：配对端口和连接端口不是同一个。ADB 授权密钥持久化于 `./data/adb`，请勿提交或分享。手机系统无线调试关闭、端口改变后，应使用实际新端口重新连接。

## 通过现有 Mihomo 加速构建（proxy-net，不使用 Host）

运行中的 EasyADB 与专属 Buildx 构建器均连接外部网络 `proxy-net`。**代理统一使用 Docker 容器名 `http://mihomo:7890`，不读取或写入 Mihomo 的容器 IP**。确保 `mihomo` 在 `proxy-net` 下可由该名称解析，且 Mihomo 的 `mixed-port: 7890` 允许同网络内连接（如 `allow-lan: true`）。不要将 7890 映射到公网。

直接在 `.env` 填：

```ini
EASYADB_BUILD_PROXY=http://mihomo:7890
```

### 首次启动前：Docker Daemon 需要能获取 BuildKit 镜像

`scripts/build-with-mihomo.sh` 使用独立的 `docker-container` Buildx 构建器。**它在接入 proxy-net 之前必须由 Docker Daemon 获取 `moby/buildkit:buildx-stable-1` 镜像。** Daemon 本身不在 `proxy-net` 中，不能通过 `http://mihomo:7890` 这个容器 DNS 名称完成首次拉取。这个一次性引导与之后 BuildKit 中的依赖下载是两件不同的事。

如果 `sudo docker pull moby/buildkit:buildx-stable-1` 连接 Docker Hub 超时，先修复 Daemon 的镜像拉取途径（例如移除已失效的 `docker.ketches.cn` 镜像源，配置 Daemon 能访问的代理），或者在另一台同架构的 Docker 设备上执行：

```sh
docker pull moby/buildkit:buildx-stable-1
docker save -o moby-buildkit.tar moby/buildkit:buildx-stable-1
```

将文件传给 FNOS 后执行：

```sh
sudo docker load -i moby-buildkit.tar
```

该方式不用为 Mihomo 开放公网端口。请勿将 `mihomo` 这个容器 DNS 名称直接写进宿主机 Docker Daemon 代理配置。修改 FNOS 全局 Docker 配置前应先备份；重启 Docker 可能影响其他容器。

### 构建并启动

```sh
# 首次部署时创建 .env，然后填写访问密钥与 Web 监听地址
cp .env.example .env

# 若之前脚本尝试启动 Buildx 失败、留下旧构建器，先清理项目专用实例：
sudo docker buildx rm easyadb-proxy

# 建议使用该脚本，不要普通 docker compose up --build：
sudo sh scripts/build-with-mihomo.sh
```

如果 `easyadb-proxy` 不存在，清理命令提示不存在可忽略。脚本先检查 BuildKit 基础镜像是否已在本地，缺失时快速给出原因；使用 `--driver-opt network=proxy-net` 创建独立构建器，为 BuildKit 和 Dockerfile 下载传入 `http://mihomo:7890`，然后 `--load` 构建镜像并运行 `docker compose up -d --no-build`。默认不会改变其他项目的构建器，也不使用 `network: host`。

Docker BuildKit 不支持在普通 `build.network` 直接指定 `proxy-net`：该字段控制 Dockerfile `RUN` 的网络模式，并非构建器容器所连接的 Docker 网络。因此这里使用专属构建器的 `--driver-opt network=proxy-net`。

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
