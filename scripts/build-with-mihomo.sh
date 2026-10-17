#!/bin/sh
set -eu

# FNOS / Linux: build and run EasyADB without host networking.
# Both the dedicated BuildKit container and EasyADB runtime join proxy-net.
# Always use the Docker network alias, never discover or embed Mihomo's IP.
NETWORK=proxy-net
MIHOMO_CONTAINER="${MIHOMO_CONTAINER:-mihomo}"
BUILDER=easyadb-proxy
BUILDER_CONTAINER=buildx_buildkit_easyadb-proxy0
BUILDKIT_IMAGE=moby/buildkit:buildx-stable-1
PROXY="${EASYADB_BUILD_PROXY:-http://mihomo:7890}"

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

# Bootstrap from proxy-net without restarting/modifying FNOS Docker daemon.
# The one-time helper uses an HTTP client on the host to download via the
# Mihomo bridge IP and docker load; this main build continues to use DNS name.
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
    echo "ERROR: existing $BUILDER has a different proxy. Review and recreate it:" >&2
    echo "  sudo docker buildx rm $BUILDER" >&2
    exit 1
  fi
else
  echo "Creating isolated BuildKit builder on $NETWORK (proxy: $PROXY)..."
  docker buildx create --name "$BUILDER" --driver docker-container \
    --driver-opt "image=$BUILDKIT_IMAGE" \
    --driver-opt "network=$NETWORK" \
    --driver-opt "env.HTTP_PROXY=$PROXY" \
    --driver-opt "env.HTTPS_PROXY=$PROXY" >/dev/null
fi

docker buildx inspect --bootstrap "$BUILDER"
echo "Building EasyADB with $PROXY..."
docker buildx build --builder "$BUILDER" --load --progress=plain \
  --tag easyadb:local \
  --build-arg "HTTP_PROXY=$PROXY" \
  --build-arg "HTTPS_PROXY=$PROXY" \
  --build-arg "http_proxy=$PROXY" \
  --build-arg "https_proxy=$PROXY" \
  --build-arg 'NO_PROXY=localhost,127.0.0.1' \
  --build-arg 'no_proxy=localhost,127.0.0.1' \
  .
docker compose up -d --no-build
