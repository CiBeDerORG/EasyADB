#!/bin/sh
set -eu

# Existing manual calls always rebuild. --if-changed is for the scheduler:
# compare tracked Git FILE TREES against the last successful deployment.
MODE=mihomo
IF_CHANGED=0
SEEN_DIRECT=0
for arg do
  case "$arg" in
    --no-proxy)
      if [ "$SEEN_DIRECT" = 1 ]; then echo 'ERROR: duplicate --no-proxy' >&2; exit 2; fi
      MODE=direct;SEEN_DIRECT=1 ;;
    --if-changed)
      if [ "$IF_CHANGED" = 1 ]; then echo 'ERROR: duplicate --if-changed' >&2; exit 2; fi
      IF_CHANGED=1 ;;
    --help|-h)
      echo "Usage: sudo sh scripts/build-with-mihomo.sh [--no-proxy] [--if-changed]"
      echo '  (default)     Existing Mihomo/proxy-net authenticated Buildx workflow'
      echo '  --no-proxy    Docker normal build/network; no Mihomo or proxy-net required'
      echo '  --if-changed  After safe Git update, build ONLY if tracked files differ'
      exit 0 ;;
    *) echo "ERROR: unsupported option: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
# Validate V2 runtime before Git update, no-change short circuit or Docker.
# An explicit environment variable wins over the local, Git-ignored .env.
VIDEO_ENGINE="${EASYADB_VIDEO_ENGINE:-}"
if [ -z "$VIDEO_ENGINE" ] && [ -f .env ]; then
  VIDEO_ENGINE="$(sed -n 's/^[[:space:]]*EASYADB_VIDEO_ENGINE[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | tr -d '\r' | sed 's/[[:space:]]*#.*$//;s/[[:space:]]*$//;s/^"//;s/"$//')"
fi
VIDEO_ENGINE="${VIDEO_ENGINE:-webrtc}"
case "$VIDEO_ENGINE" in
  webrtc) ;;
  mse) echo 'ERROR: FFmpeg + MSE was removed in V2; set EASYADB_VIDEO_ENGINE=webrtc in .env.' >&2; exit 2 ;;
  webcodecs) echo 'ERROR: WebCodecs is reserved and unimplemented; set EASYADB_VIDEO_ENGINE=webrtc.' >&2; exit 2 ;;
  *) echo 'ERROR: unsupported EASYADB_VIDEO_ENGINE; V2 supports only webrtc.' >&2; exit 2 ;;
esac
echo 'WebRTC: Linux host networking; allow NAS ICE dynamic UDP ports over EasyTier.'

. scripts/deploy-lock.sh
if acquire_deploy_lock; then :; else
  lock_status=$?
  if [ "$lock_status" -eq 75 ]; then
    echo 'ERROR: another EasyADB deployment is already running; retry after it finishes.' >&2
  fi
  exit "$lock_status"
fi

DEPLOY_MARKER=data/storage/.easyadb-last-deployed-tree
deploy_git() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ]; then
    sudo -H -u "#${SUDO_UID}" git "$@"
  else
    git "$@"
  fi
}
git_tree() { deploy_git rev-parse 'HEAD^{tree}' 2>/dev/null || :; }
write_deployed_tree() {
  if [ -n "$BUILD_TREE" ]; then
    # All supported deployment entry points share the lock. If an external
    # Git operation changed the checkout anyway, do not certify its new HEAD
    # (or an uncertain mixed build context) as successfully deployed.
    if [ "$(git_tree)" != "$BUILD_TREE" ]; then
      echo 'ERROR: Git files changed during deployment; successful version marker was not advanced.' >&2
      return 1
    fi
    mkdir -p data/storage
    printf '%s\n' "$BUILD_TREE" > "$DEPLOY_MARKER.tmp.$$"
    mv -f "$DEPLOY_MARKER.tmp.$$" "$DEPLOY_MARKER"
  fi
}

# update-m2.sh refuses dirty checkouts, protects .env/data and pulls ff-only.
# Seed the first scheduled check with the existing checkout as its baseline:
# that checkout is assumed to be the already running deployment.
# Do NOT overwrite a marker after a failed Docker build; retry next schedule.
if [ "${EASYADB_UPDATED:-0}" != 1 ]; then
  if [ "$IF_CHANGED" = 1 ] && [ ! -f "$DEPLOY_MARKER" ]; then
    before="$(git_tree)"
    if [ -n "$before" ]; then
      mkdir -p data/storage
      printf '%s\n' "$before" > "$DEPLOY_MARKER.tmp.$$"
      mv -f "$DEPLOY_MARKER.tmp.$$" "$DEPLOY_MARKER"
    fi
  fi
  sh scripts/update-m2.sh
  EASYADB_UPDATED=1
  export EASYADB_UPDATED
  exec sh scripts/build-with-mihomo.sh "$@"
fi
BUILD_TREE="$(git_tree)"
if [ "$IF_CHANGED" = 1 ] && [ -f "$DEPLOY_MARKER" ]; then
  deployed_tree="$(cat "$DEPLOY_MARKER")"
  if [ -n "$BUILD_TREE" ] && [ "$BUILD_TREE" = "$deployed_tree" ]; then
    echo "No tracked Git file changes since the last successful deployment ($BUILD_TREE); skipping Docker."
    exit 0
  fi
fi

if [ "$MODE" = direct ]; then
  # Build without Mihomo; the V2 runtime remains WebRTC host-networked.
  if ! docker compose version >/dev/null 2>&1; then
    echo 'ERROR: Docker Compose v2 is required.' >&2
    exit 1
  fi
  echo "Building EasyADB without a scripted proxy (Docker/OpenWrt networking)..."
  # No Mihomo bridge IP, --add-host, BuildKit proxy builder or custom proxy args.
  # External Docker daemon/network settings remain under the host's control.
  docker build --progress=plain --tag easyadb:local .
  docker compose -f compose.webrtc.yaml up -d --no-build
  write_deployed_tree
  exit 0
fi

# FNOS / Linux: retain the Mihomo-assisted BuildKit path.
# Only the BuildKit builder joins proxy-net; EasyADB uses WebRTC host-network
# Compose. Buildx resolves the builder's transient bridge IP as before.
NETWORK=proxy-net
MIHOMO_CONTAINER="${MIHOMO_CONTAINER:-mihomo}"
BUILDER=easyadb-proxy
BUILDER_CONTAINER=buildx_buildkit_easyadb-proxy0
BUILDKIT_IMAGE=moby/buildkit:buildx-stable-1
. scripts/proxy-config.sh

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "ERROR: existing Docker network $NETWORK was not found." >&2
  exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$MIHOMO_CONTAINER" 2>/dev/null || true)" != true ]; then
  echo "ERROR: $MIHOMO_CONTAINER is not running." >&2
  exit 1
fi
if [ "$(docker inspect -f '{{if index .NetworkSettings.Networks "proxy-net"}}yes{{end}}' "$MIHOMO_CONTAINER")" != yes ]; then
  echo "ERROR: $MIHOMO_CONTAINER must be attached to proxy-net." >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo 'ERROR: Docker Buildx is required.' >&2
  exit 1
fi

# The Buildx CLI itself can fetch Docker Hub auth tokens. Since it runs on
# FNOS, it needs a host-reachable proxy URL, while the BuildKit container
# continues using the mihomo hostname in proxy-net.
. scripts/proxy-host.sh

# Bootstrap from proxy-net without restarting/modifying FNOS Docker daemon.
# The one-time helper uses an HTTP client on the host to download via the
# Mihomo bridge IP and docker load; BuildKit RUN stages use the mihomo DNS name.
if ! docker image inspect "$BUILDKIT_IMAGE" >/dev/null 2>&1; then
  echo "BuildKit image missing; bootstrapping through Mihomo..."
  sh scripts/bootstrap-buildkit-via-mihomo.sh
fi

# A previous failed bootstrap may leave a registered builder without its container.
# Remove only this dedicated EasyADB builder, never another project's builder.
if docker buildx inspect "$BUILDER" >/dev/null 2>&1 &&
   ! docker container inspect "$BUILDER_CONTAINER" >/dev/null 2>&1; then
  echo "Removing incomplete EasyADB-only builder $BUILDER..."
  docker buildx rm "$BUILDER"
fi

if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{if index .NetworkSettings.Networks "proxy-net"}}yes{{end}}' "$BUILDER_CONTAINER")" != yes ]; then
    echo "ERROR: existing $BUILDER is not attached to proxy-net. Review and recreate it." >&2
    exit 1
  fi
  if ! docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$BUILDER_CONTAINER" |
      grep -Fx "HTTPS_PROXY=$PROXY" >/dev/null; then
    echo "Recreating EasyADB-only builder because proxy credentials changed..."
    docker buildx rm "$BUILDER"
  fi
fi

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "Creating isolated BuildKit builder on $NETWORK (proxy credentials hidden)..."
  docker buildx create --name "$BUILDER" --driver docker-container \
    --driver-opt "image=$BUILDKIT_IMAGE" \
    --driver-opt "network=$NETWORK" \
    --driver-opt "env.HTTP_PROXY=$PROXY" \
    --driver-opt "env.HTTPS_PROXY=$PROXY" >/dev/null
fi

# Do not use 'docker buildx inspect --bootstrap' here. Its Driver Options
# print the full authenticated proxy URL, including the password.
# A build automatically starts the dedicated builder when needed.

echo "Building EasyADB via Mihomo..."
# Force the host-side Buildx CLI's registry token exchange through Mihomo too.
# Dockerfile RUN workers do not inherit proxy-net DNS; --add-host gives them
# a build-scoped 'mihomo' entry with the current bridge IP, without host mode
# or saving it in .env. Docker API traffic continues over the Unix socket.
# Never echo HOST_PROXY (it includes credentials).
HTTP_PROXY="$HOST_PROXY" HTTPS_PROXY="$HOST_PROXY" \
http_proxy="$HOST_PROXY" https_proxy="$HOST_PROXY" \
NO_PROXY='localhost,127.0.0.1' no_proxy='localhost,127.0.0.1' \
docker buildx build --builder "$BUILDER" --load --progress=plain \
  --tag easyadb:local \
  --add-host "mihomo:${MIHOMO_IP}" \
  --build-arg "HTTP_PROXY=$PROXY" \
  --build-arg "HTTPS_PROXY=$PROXY" \
  --build-arg "http_proxy=$PROXY" \
  --build-arg "https_proxy=$PROXY" \
  --build-arg 'NO_PROXY=localhost,127.0.0.1' \
  --build-arg 'no_proxy=localhost,127.0.0.1' \
  .
docker compose -f compose.webrtc.yaml up -d --no-build
write_deployed_tree
