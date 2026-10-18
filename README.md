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

## 通过现有 Mihomo 加速构建（proxy-net，含首次 BuildKit 引导）

**只需运行一个命令：**

```sh
sudo sh scripts/build-with-mihomo.sh
```

脚本检查现有 `proxy-net` 与 `mihomo`，并在首次缺少 `moby/buildkit:buildx-stable-1` 时自动调用 `scripts/bootstrap-buildkit-via-mihomo.sh`。后者使用官方 `crane` 从 Docker Registry 经 Mihomo 下载镜像 tar 包，再用 `docker load` 本地导入；**不会修改 FNOS 的 daemon.json、重启 Docker，也不依赖已失效的 docker.ketches.cn 镜像加速源**。官方 crane 发布包会与同一发行版的 `checksums.txt` 核对 SHA-256 后使用（默认 v0.22.1）。<https://github.com/google/go-containerregistry/tree/main/cmd/crane>

**两个代理地址的区别：** FNOS 宿主机不在 `proxy-net` 的 Docker DNS 中，所以只在一次性 bootstrap helper 中临时读取 Mihomo 的 *桥接 IP*，供宿主机 curl/crane 直接代理下载。EasyADB 与 BuildKit 构建器真正运行后，都加入 `proxy-net`，**始终使用 `http://mihomo:7890` 这个容器名**，不会把临时 IP 保存到配置。

`.env` 建议填写：

```ini
EASYADB_BUILD_PROXY=http://mihomo:7890
```

检查 Mihomo 已加入 `proxy-net` 且允许同网络访问 `mixed-port: 7890`（如 `allow-lan: true`、`bind-address: '*'`）；不要把代理端口开放到公网。首次下载需 FNOS 自带 `curl`、`tar`、`sha256sum` 和可用的系统 CA 证书；目前 helper 支持 Linux amd64 / arm64。下载临时文件放在仓库 `.cache/`，操作完成后自动清理；磁盘紧张可通过 `EASYADB_BOOTSTRAP_CACHE` 指定别的目录。

还可以只验证一次性镜像引导，不启动 EasyADB：

```sh
sudo sh scripts/bootstrap-buildkit-via-mihomo.sh
sudo docker image inspect moby/buildkit:buildx-stable-1
```

随后主脚本使用专属 `docker-container` Buildx 构建器 `easyadb-proxy`，以 `--driver-opt network=proxy-net` 加入既有网络；构建器自身的 HTTP/HTTPS 代理及 Dockerfile 中的 apt/curl/pip 下载代理均为 `http://mihomo:7890`。构建时使用 `--load`，最后通过 `docker compose up -d --no-build` 启动服务；不更改其他项目默认构建器。如果之前失败留下一个没有容器的同名 EasyADB 构建器，主脚本会仅清理这个项目专用的残留构建器。

**注意：** `build.network: proxy-net` 不能代替这套做法；它控制 Dockerfile 中 RUN 的网络模式，不等同于构建器容器所在的自定义 Docker 网络。正常启动请使用主脚本，而不是裸跑 `docker compose up --build`。

---

### 遇到 HTTP 407：代理要求认证

如果 bootstrap 检查 Registry 时显示 `CONNECT tunnel failed, response 407`，说明已经访问到代理，但 CONNECT 请求被代理认证拒绝（也可能来自其上游代理），不是 Docker 构建网络不通。**部署页面的 `external-controller-cors` / trusted Web origins 仅控制管理 API 跨域访问，与 mixed-port 7890 的认证无关。**

先检查来源网络 CIDR（不要猜测网段）：

```sh
sudo docker network inspect proxy-net --format 'Subnet={{(index .IPAM.Config 0).Subnet}} Gateway={{(index .IPAM.Config 0).Gateway}}'
```

在真正运行中的 Mihomo 配置中检查 `authentication` 与 `skip-auth-prefixes`。若你信任整个 `proxy-net`，可以在 `skip-auth-prefixes` 中**追加实际的 Subnet CIDR**（例如检测结果确实为 `172.19.0.0/16` 时）：

```yaml
skip-auth-prefixes:
  - 172.19.0.0/16
```

与 `authentication`、`allow-lan` 同级配置并重载 Mihomo；不要加到 `external-controller-cors` 下，也不要使用 `0.0.0.0/0` 来绕开认证。该网段内所有容器都将跳过代理认证，不希望如此时请保留认证并为客户端单独配置代理凭据。

复测：

```sh
sudo curl -sS -i -x http://172.19.0.2:7890 https://registry-1.docker.io/v2/
```

把示例 IP 换成脚本报告的 Mihomo 实际 IP。出现 Registry 的 HTTP 401 和 `UNAUTHORIZED` 是正常的未登录 Registry 响应，**不同于 Proxy 407**。如果 Mihomo 并未启用本地 `authentication` 但仍返回 407，检查当前选中的上游 HTTP 代理是否要求认证。

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
