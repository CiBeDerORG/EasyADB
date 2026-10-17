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
