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

# Bootstrapping requires the Docker daemon to pull moby/buildkit FIRST.
# Docker daemon is not a container on proxy-net; the name "mihomo" cannot
# resolve there. Avoid misleading timeouts when the one-time image is missing.
if ! docker container inspect "$BUILDER_CONTAINER" >/dev/null 2>&1 &&
   ! docker image inspect "$BUILDKIT_IMAGE" >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: one-time BuildKit bootstrap image is not available locally:
  moby/buildkit:buildx-stable-1
Docker daemon must pull or load this image BEFORE the proxy-net builder
can run. Docker daemon cannot resolve the container hostname "mihomo".
After fixing the daemon's registry access, run:
  sudo docker pull moby/buildkit:buildx-stable-1
Alternatively, import the image from another Docker machine:
  sudo docker load -i moby-buildkit.tar
Then rerun this script. Do not expose Mihomo's 7890 to the Internet.
EOF
  exit 1
fi

if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  if ! docker container inspect "$BUILDER_CONTAINER" >/dev/null 2>&1; then
    echo "ERROR: $BUILDER exists without its container (previous bootstrap may have failed)." >&2
    echo "Inspect it, then remove only that dedicated builder and retry:" >&2
    echo "  sudo docker buildx rm $BUILDER" >&2
    exit 1
  fi
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
