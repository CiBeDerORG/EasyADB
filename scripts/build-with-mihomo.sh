#!/bin/sh
set -eu

# Dedicated non-host BuildKit builder on the existing proxy-net network.
# Run from the repository root on FNOS/Linux. No proxy port publishing needed.
MIHOMO_CONTAINER="${MIHOMO_CONTAINER:-mihomo}"
MIHOMO_PORT="${MIHOMO_PORT:-7890}"
BUILDER="easyadb-proxy"

if ! docker network inspect proxy-net >/dev/null 2>&1; then
  echo 'ERROR: external Docker network proxy-net not found.' >&2
  exit 1
fi
MIHOMO_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy-net"}}{{.IPAddress}}{{end}}' "$MIHOMO_CONTAINER")"
if [ -z "$MIHOMO_IP" ]; then
  echo 'ERROR: Mihomo is not attached to proxy-net.' >&2
  exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$MIHOMO_CONTAINER")" != true ]; then
  echo 'ERROR: Mihomo is not running.' >&2
  exit 1
fi
PROXY="http://${MIHOMO_IP}:${MIHOMO_PORT}"

if ! docker buildx version >/dev/null 2>&1; then
  echo 'ERROR: Docker Buildx is required.' >&2
  exit 1
fi
if docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "Reusing dedicated builder: ${BUILDER}"
  docker buildx inspect --bootstrap "$BUILDER" >/dev/null
else
  echo 'Creating a dedicated docker-container builder on proxy-net...'
  docker buildx create --name "$BUILDER" --driver docker-container \
    --driver-opt network=proxy-net --bootstrap >/dev/null
fi
BUILDER_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy-net"}}{{.IPAddress}}{{end}}' "buildx_buildkit_${BUILDER}0")"
if [ -z "$BUILDER_IP" ]; then
  echo "ERROR: ${BUILDER} is not attached to proxy-net. Remove/recreate that dedicated builder after reviewing its configuration." >&2
  exit 1
fi

echo "Buildx builder: ${BUILDER} (proxy-net: ${BUILDER_IP})"
echo "Using existing Mihomo proxy: ${PROXY}"
echo 'NOTE: Docker/BuildKit still pulls base images separately; remove the broken registry mirror and configure daemon/builder image pulls if required.'

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
