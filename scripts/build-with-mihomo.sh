#!/bin/sh
set -eu

# Default: preserve the existing authenticated Mihomo/BuildKit path.
# --no-proxy: use Docker's own networking (e.g. OpenWrt transparent proxy),
# without reading EASYADB_BUILD_PROXY or requiring mihomo/proxy-net.
case "$#" in
  0) MODE=mihomo ;;
  1)
    case "$1" in
      --no-proxy) MODE=direct ;;
      --help|-h)
        echo "Usage: sudo sh scripts/build-with-mihomo.sh [--no-proxy]"
        echo "  (default)   Existing Mihomo/proxy-net authenticated Buildx workflow"
        echo "  --no-proxy  Docker's normal build/network; no Mihomo or proxy-net required"
        exit 0 ;;
      *) echo "ERROR: unsupported option: $1" >&2; exit 2 ;;
    esac ;;
  *) echo "ERROR: expected no options or --no-proxy" >&2; exit 2 ;;
esac

# Update first, then re-exec the freshly pulled script with the SAME mode.
# The old script previously dropped positional arguments at this boundary.
cd "$(dirname "$0")/.."
if [ "${EASYADB_UPDATED:-0}" != 1 ]; then
  sh scripts/update-m1.sh
  EASYADB_UPDATED=1
  export EASYADB_UPDATED
  exec sh scripts/build-with-mihomo.sh "$@"
fi

if [ "$MODE" = direct ]; then
  # This compose file is self-contained: it does NOT mention proxy-net, Mihomo
  # or proxy build args. It retains the same Compose project, image, volumes
  # and published ports as the default mode.
  if ! docker compose version >/dev/null 2>&1; then
    echo 'ERROR: Docker Compose v2 is required.' >&2
    exit 1
  fi
  echo "Building EasyADB without a scripted proxy (Docker/OpenWrt networking)..."
  # No Mihomo bridge IP, --add-host, BuildKit proxy builder or custom proxy args.
  # External Docker daemon/network settings remain under the host's control.
  docker build --progress=plain --tag easyadb:local .
  docker compose -f compose.no-proxy.yaml up -d --no-build
  exit 0
fi

# FNOS / Linux: original Mihomo path, unchanged below this point.
# BuildKit/EasyADB use the mihomo Docker alias. Host-side Buildx CLI resolves
# a temporary bridge IP; no host networking.

# Both the dedicated BuildKit container and EasyADB runtime join proxy-net.
# BuildKit/EasyADB use the mihomo Docker alias. Host-side Buildx CLI resolves a temporary bridge IP.
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
docker compose up -d --no-build
