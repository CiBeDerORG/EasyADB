# Migration script snapshots

These files are test inputs, never installed or called by the production entry
points. They let shallow CI exercise an actual local Git update twice without
depending on remote history or downloading another branch.

- `legacy/`: exact `scripts/build-with-mihomo.sh`, `scripts/update-m2.sh`, and
  `scripts/scheduled-deploy.sh` from M3 commit
  `5ff047fa3a4dbe0aed75e1a06fa0d4d20042787a`.
- `v4/`: exact copies of the same three paths from V4 commit
  `18ce0f06f1ad3bfa19924aacb9296cd4af5816df`, captured on 2026-10-21.
  The builder is unchanged from the previous V4 version; updater/scheduler
  normalize the M3 source to V4, fetch the exact V4
  ref, and create a local branch without requiring an upstream fetch mapping.

The integration fixture creates a bare remote and genuinely divergent M3 bridge
and V4 branches. The installation starts with the legacy scripts and a
single-branch M3 fetch mapping, then runs the original command. Only Docker,
crontab and proxy/network ports are mocked. Git is restricted to the local file
transport; there is no real deployment, daemon, cron edit or network request.

Keep the V4 snapshots synchronized when the handoff contract changes. The
regression suite asserts the real marker/re-exec, explicit Git target, runtime
rejection, canonical WebRTC Compose, changed-tree skip and failed-build retry
contracts; it does not replace the target builder with a success stub.

V4 snapshot SHA-256 values at capture:

| File | SHA-256 |
| --- | --- |
| build-with-mihomo.sh | 8cc1abfaeaf1d41d2130996fda4301aaabf71f28b5cbaf95e22386982be2198e |
| update-m2.sh | 16c31ee21f85441179d5bc3a1076baaf661a9110d42c0360b82c2270f03904eb |
| scheduled-deploy.sh | 6cf77124f17d5ec0edc88fddd28924332fb13166de9ea4db327f6e1720e83e33 |
