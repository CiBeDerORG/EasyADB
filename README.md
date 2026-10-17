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

## 通过现有 Mihomo 加速构建（FNOS / Linux）

EasyADB 运行时加入已经存在的 Docker 外部网络 `proxy-net`，**不会**新建 Mihomo 容器，也不要求映射 7890 端口到公网。构建阶段的 apt、curl 和 pip 可使用 Mihomo 代理；镜像 `FROM python:3.12-slim-bookworm` 由 Docker Daemon/BuildKit 拉取，不受 Compose `build.args` 控制，需要单独配置。

1. 确认 `mihomo` 已加入 `proxy-net` 且其 mixed-port 为 7890。原配置若为 `allow-lan: false`，来自其他容器及宿主机 IP 的代理请求可能被拒绝；请在现有 Mihomo 配置中检查并按需改为 `allow-lan: true`，`bind-address: '*'`，然后重载。请勿把 7890 映射或开放到公网。
2. 在 FNOS 主机查询代理容器在 `proxy-net` 中的 IP：

```sh
MIHOMO_IP="$(sudo docker inspect -f '{{with index .NetworkSettings.Networks "proxy-net"}}{{.IPAddress}}{{end}}' mihomo)"
printf 'Mihomo proxy: http://%s:7890\n' "$MIHOMO_IP"
curl -fsS --connect-timeout 5 --max-time 20 -x "http://$MIHOMO_IP:7890" -o /dev/null https://pypi.org/simple/
```

如果最后一条失败，先修复 Mihomo 的监听、LAN 权限或节点规则。容器 IP 在重建后可能变化，不能将 `mihomo` 当作宿主机 Docker Daemon 可解析的域名。构建时 `build.network: host` 只作用于 Dockerfile 的 `RUN` 阶段，让宿主机能够访问 Mihomo 在 Docker 桥接网络上的 IP。

3. **先处理 Python 基础镜像拉取**。若 `docker info` 的 `Registry Mirrors` 仍有返回 502 的 `https://docker.ketches.cn`，在 FNOS 的 Docker 配置中移除该故障镜像源；不能单靠增加 `build.args` 修复。配置 Docker Daemon 使用下面的 HTTP/HTTPS 代理（把 IP 替换成上一步的实际值，保留 daemon.json 中其他已有设置）：

```json
{
  "proxies": {
    "http-proxy": "http://<MIHOMO_IP>:7890",
    "https-proxy": "http://<MIHOMO_IP>:7890",
    "no-proxy": "localhost,127.0.0.1"
  }
}
```

上面是示意配置，不可原样复制其中的 `<MIHOMO_IP>`。Docker Engine 23+ 通常可以通过 daemon.json 配置；FNOS 的 Docker 管理方式可能不同，以实际 Daemon 配置位置为准。**重启 Docker 服务可能影响 NAS 上所有容器**，先检查当前配置、备份并安排合适时机操作。使用独立 buildx docker-container 构建器时，还需另行设置对应 BuildKit 的代理。验证：

```sh
sudo docker info
sudo docker pull python:3.12-slim-bookworm
```

4. 基础镜像可正常拉取后，在仓库目录用自动识别脚本构建并启动（如果账户可直接使用 Docker，可省略 `sudo`）：

```sh
cp .env.example .env
# 在 .env 中设置随机 EASYADB_TOKEN 和所需 EASYADB_BIND_IP
sudo sh scripts/build-with-mihomo.sh
```

脚本通过 `docker inspect` 动态查询 `mihomo` 在 `proxy-net` 上的 IP，先用 Mihomo 测试下载站点，再将 `EASYADB_BUILD_PROXY` 作为临时构建参数传给 Compose，执行 `docker compose up -d --build`。也可以不使用脚本，直接在 `.env` 的 `EASYADB_BUILD_PROXY` 设置实际代理 URL 再运行 Compose。**代理构建参数不会作为 EasyADB 运行时环境变量持久化**；ADB 到手机的通信仍按现有路由直接进行。

如果 FNOS 使用的 buildx 构建器不允许 `build.network: host`，请使用支持 host 构建网络的 Docker/BuildKit 配置，或者让宿主机提供受限、可从默认构建网络访问的 Mihomo 代理地址；不要误把 `build.network` 写成 `proxy-net`（它并不是运行期 Compose 网络）。

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
