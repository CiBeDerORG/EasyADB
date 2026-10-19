# EasyADB M2 · parallel batch operations

The UI has one selected-device set for batch actions. Actions are **manual
only** and never auto-connect, switch IPs or retry another route.

- **Connect:** browser starts at most four independent POST /connect requests
  at once. A completed/failed request releases its worker slot for the next
  selected device. Existing FastAPI synchronous endpoints execute in its
  threadpool; DeviceManager has one RLock per device ID, not a global device
  operation mutex. Selected serial/route is resolved independently per device.
  Outcomes are reported per-device and the list is refreshed only once after
  the entire batch completes. Existing live sessions are skipped.
- **Start:** selected connected, free devices (up to remaining four live slots)
  all get their own card and WebSocket in one synchronous dispatch. Their
  ADB checks, scrcpy workers, MSE initializations or WebRTC SDP/ICE negotiations
  progress independently. There is **no first-frame dependency** between
  phones. Reservation is per device, protected by LiveRegistry. One device
  failure must not kill a healthy peer.
- **Stop:** the selected device's existing WS gets an explicit stop, all
  requests dispatched before awaiting any worker's cleanup. Each response
  reports independent progress. A device only reports clean stop upon
  `cleanup_complete=true`; dirty or timed-out cleanup must not release the
  registry slot by assumption, and never triggers unattended reconnect.
  Devices not selected are left live and their remote controls untouched.

Batch stop/control are event-loop asynchronous rather than browser OS threads:
the expensive per-device ADB subprocess and scrcpy streaming work runs in
separate server threads/processes. Do not misrepresent browser Promise
concurrency as Web Worker threads.

Test coverage: `tests/m2_batch_connect.cjs` (four simultaneous requests,
slow/offline isolation); `tests/test_m2_batch_concurrency.py` (two real
threads reach a common ADB connect barrier); `tests/m2_multi_contract.cjs`
(simultaneous multi-video opening, out-of-order per-device initialization and
cleanup, four-slot and selected-only isolation).
