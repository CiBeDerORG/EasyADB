# M2 · Video engine 2: WebRTC (EasyTier / Linux NAS)

This implementation does NOT remove or convert the original FFmpeg+MSE
pipeline. Select the runtime engine exclusively by `.env`:

```dotenv
EASYADB_VIDEO_ENGINE=mse        # original, default (unchanged)
# EASYADB_VIDEO_ENGINE=webrtc   # implemented: scrcpy Annex-B H264 -> RTP -> WebRTC
# EASYADB_VIDEO_ENGINE=webcodecs # API reserved; UI refuses playback for now
```

## Architecture

- Existing explicit/manual ADB connection and per-device WS session remain.
- One scrcpy server and separate original control/video sockets **per device**.
- WebRTC: scrcpy complete H264 access units and original microsecond PTS go
  directly to an aiortc `av.Packet` video track; aiortc packetizes RTP and
  sends via encrypted DTLS-SRTP. No FFmpeg, MSE or second device encoder.
- Existing authenticated same-origin WS carries one bounded offer/answer,
  selected-route-bound remote control, diagnostic heartbeat, and cleanup.
- Up to four concurrent video sessions, each with a separate peer and track.
- Missing/overloaded frame queue drops stale delta frames until an IDR with
  cached SPS/PPS; does not grow latency indefinitely. No auto ADB reconnect.
- RTCPeerConnection uses `iceServers: []` for first-pass routed LAN/EasyTier
  testing. No third-party STUN/TURN, no camera/microphone capture.
- WebRTC session starts capture only after receiving this session's authenticated
  offer and responding with a local ICE-complete SDP answer.

## Deployment

WebRTC mode selects `compose.webrtc.yaml` automatically from
`scripts/build-with-mihomo.sh`, including with `--no-proxy`.
This is a **Linux-only host-network container**. aioice currently allocates
dynamic ICE UDP ports; do not assume that mapping a single container UDP port
makes WebRTC work. Host networking lets ICE advertise real NAS/EasyTier
interface IPs and receive UDP there, with no Docker bridge address leakage.
The original `compose.yaml` and `compose.no-proxy.yaml` remain intact for MSE.

1. Set `EASYADB_VIDEO_ENGINE=webrtc` in local `.env`.
2. Set `EASYADB_BIND_IP=0.0.0.0` or a specifically routable NAS/EasyTier
   interface address. Host mode binds the HTTP server at `EASYADB_PORT`
   (default 8765) rather than port 8000 in an isolated container. Protect this
   service with trusted routing/firewall, especially because login/control
   remains HTTP without transport encryption.
3. Rebuild using `sudo sh scripts/build-with-mihomo.sh` (or `--no-proxy`).
4. Check `http://<reachable NAS IP>:8765/api/m2/video-engine` returns
   `{"engine":"webrtc","implemented":true}`.
5. Allow browser → NAS UDP **dynamic local ICE ports** in LAN/EasyTier
   firewall policy. Verify bidirectional routing, not just HTTP/TCP. Use
   `chrome://webrtc-internals` to inspect selected ICE pair; do NOT point
   candidates to a container's 172.x Docker IP.
6. Explicitly connect one device via ADB and start its realtime picture. The
   event log should show WebRTC negotiation and frame activity.

Linux host networking drops the old runtime proxy-net attachment; the Mihomo
BuildKit proxy remains separate and unaffected. If other host services already
listen on your chosen HTTP port, change EASYADB_PORT. Returning to `mse`
selects the legacy Compose on the next rebuild, with DB/ADB volumes unchanged.

### Important limitations

- This release does **not** use fixed-port Pion ICEUDPMux. aiortc uses dynamic
  host ICE ports. Do not open wide UDP ranges to the public internet; scope
  firewall access to your trusted EasyTier/LAN subnet, or provide a dedicated
  network/relay design later.
- The phone still feeds the source stream through ADB TCP over EasyTier. If
  Android/scrcpy video capture itself stalls, WebRTC cannot manufacture frames.
- Browser video H264 codec/profile support and vendor encoders differ; first
  test with economy/baseline quality. A control channel can remain live while
  the video track stalls.
- This mode is opt-in, not a silent replacement for existing MSE users.
- WebCodecs is deliberately reported unimplemented rather than playing fMP4
  into VideoDecoder.
