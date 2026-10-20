# M2 · WebRTC runtime (EasyTier / Linux NAS)

> Updated for V2. This is the **current runtime**, not the earlier optional M2
> experiment. Historical M2 notes remain in their separate documents.

## Supported configuration

```dotenv
EASYADB_VIDEO_ENGINE=webrtc
EASYADB_MAX_STARTING=3
# EASYADB_BIND_IP=10.10.10.x  # use an actual NAS/EasyTier interface address
# EASYADB_PORT=8765
```

- WebRTC is the only implemented video engine. FFmpeg + MSE was removed in V2;
  `mse` is rejected by the build script and server. `webcodecs` is reserved
  and unimplemented, not an available fallback.
- Up to **20 explicitly opened logical device sessions**, one per device.
  The independent start/SDP/ICE admission budget `EASYADB_MAX_STARTING`
  defaults to **3** and accepts 1–20; it is not the total session-slot cap.
- Each session uses one scrcpy server with separate original video/control
  sockets. H.264 Annex-B access units and microsecond PTS feed aiortc encoded
  `av.Packet` RTP without decoding, transcoding, or a second phone encoder.
  RTP media uses DTLS-SRTP / ICE; authenticated same-origin WebSocket carries
  signaling, per-session control, heartbeat and metadata only, not video bytes
  or old fMP4/MSE fragments.
- The browser uses a WebRTC `MediaStream`. Diagnostics track actual browser
  RTP receive bytes, decoded/dropped frames, browser-local frame paint timing,
  phone H.264 packet counts, worker process usage and session status; they
  do not report fabricated MSE append/buffer/queue statistics.
- The track has bounded frame queue and pre-event-loop cross-thread callback
  budgets. After overflow, stale frames are dropped until a fresh IDR with
  cached SPS/PPS. Static screens and browser frame age alone do not prove
  end-to-end latency or Android capture failure. No automatic ADB reconnect.

## Deployment

Both Mihomo-assisted and `--no-proxy` builds in
`scripts/build-with-mihomo.sh` launch the canonical
`compose.webrtc.yaml`. The optional manual `compose.yaml` and
`compose.no-proxy.yaml` entries share the same WebRTC host-network runtime;
only image-build proxy arguments differ. Do not stack alternative Compose
files using multiple `-f` flags. The Mihomo BuildKit proxy remains separate
from the running EasyADB container.

Linux host networking is required because aioice allocates dynamic local ICE
UDP ports; exposing a single Docker UDP port or advertising a Docker bridge
address is not sufficient. Uvicorn binds `EASYADB_BIND_IP` (default
`127.0.0.1`) and `EASYADB_PORT` (default `8765`) directly on the host.
Configure an actually reachable NAS/EasyTier address for remote use, and
restrict HTTP control and dynamic UDP access to trusted clients. Browser peers
use `iceServers: []` in the current routed LAN/EasyTier implementation;
STUN/TURN and fixed-port Pion ICEUDPMux are not implemented.

1. Set `EASYADB_TOKEN` to a unique secret (minimum 12 characters), and set
   `EASYADB_VIDEO_ENGINE=webrtc` in your local `.env`. Do not commit it.
2. Select a routable `EASYADB_BIND_IP` and a nonconflicting `EASYADB_PORT`.
   Optionally set `EASYADB_MAX_STARTING` between 1 and 20.
3. Rebuild via `sudo sh scripts/build-with-mihomo.sh` or add `--no-proxy`
   to build without the scripted Mihomo proxy. Back up the NAS configuration
   and SQLite data before a real migration.
4. Check `http://<NAS-IP>:8765/api/m2/video-engine` reports
   `{"engine":"webrtc","implemented":true,"max_starting":3}` with the defaults.
   Adjust port and expected quota if customized.
5. Permit browser to NAS dynamic local ICE UDP on trusted EasyTier/LAN routes;
   inspect the selected ICE pair with `chrome://webrtc-internals`. Verify
   bidirectional routing; do not use a Docker 172.x bridge candidate.
6. Explicitly connect one device over ADB and start its WebRTC picture.
   Confirm signaling, RTP frames, per-device control and clean stop before
   increasing the concurrent session count.

## Known limits and verification status

- Protect the HTTP control endpoint using a trusted network and suitable
  external TLS termination before any public internet exposure.
- The source remains Android/scrcpy over ADB TCP. A stalled device capture
  cannot be repaired by the browser's WebRTC receiver.
- H.264 codec/profile support varies by browser and device encoder; start
  with baseline quality and verify the actual endpoint.
- CI/Mock passing does **not** constitute real FNOS/NAS, Android, OpenWrt or
  EasyTier acceptance. Follow `V2-ACCEPTANCE.md` for the 1/2/5/10/20-session,
  long-run, stop/release and abnormal-network tests.
