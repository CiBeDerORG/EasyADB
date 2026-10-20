# EasyADB V2 · WebRTC-only 部署说明

V2 已退休 FFmpeg + MSE。唯一正式视频链路为 **scrcpy H.264 编码数据 → aiortc encoded packet → ICE/DTLS-SRTP → 浏览器 WebRTC**。控制、诊断、首消息 token 与 SDP offer/answer 仍通过原鉴权、同源的每设备 WebSocket 传输。

## V1 升级注意事项

1. 备份原有 `.env`、`data/storage/devices.sqlite3` 和部署脚本；不要清库。
2. 修改旧 `.env` 的 `EASYADB_VIDEO_ENGINE=mse` 为 `EASYADB_VIDEO_ENGINE=webrtc`。V2 对旧值**明确拒绝**，不做静默回退。
3. WebRTC 需要 NAS 与浏览器之间可路由的动态 ICE UDP；V2 正式 `compose.yaml` 和 `compose.no-proxy.yaml` 使用 Linux host networking。Mihomo `proxy-net` 仍可供专用 BuildKit 构建，但不用于视频运行容器。
4. 将 `EASYADB_BIND_IP` 设置为本机可信 EasyTier/LAN IP 或按防火墙规划绑定；检查 `EASYADB_PORT` 与其他主机服务无冲突。默认 localhost，远端访问需手动开启并保护管理接口。
5. 镜像不再安装 FFmpeg；旧 `web/m2-player.js` 和 `compose.webrtc.yaml` 已移除。原 HTTP/WS 鉴权和数据文件位置不变。
6. 访问 `/api/m2/video-engine` 应得到 `{"engine":"webrtc","implemented":true}`，浏览器须支持 WebRTC H.264。验证 ICE selected pair 地址不是不可路由的 Docker 172.x 地址。
7. 实机确认浏览器启动、解锁、控制、主动停止、异常断线、WebRTC Peer 清理；不要用自动化 Mock 冒充真实 NAS/Mate30 验收。

WebRTC-only 不意味着启动后台保活。只有用户明确打开投屏才创建视频及其会话内的必要监听。清理不完整时继续占用 Session 槽位，安全优先。

实际 V2 分阶段状态见 [V2-PLAN.md](V2-PLAN.md)。
