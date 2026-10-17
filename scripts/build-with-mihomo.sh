#!/bin/sh
set -eu

# Run on the FNOS/Linux Docker host, not inside the EasyADB container.
# Example if your account needs Docker permissions: sudo sh scripts/build-with-mihomo.sh
MIHOMO_CONTAINER="${MIHOMO_CONTAINER:-mihomo}"
MIHOMO_PORT="${MIHOMO_PORT:-7890}"

if ! docker network inspect proxy-net >/dev/null 2>&1; then
  echo 'ERROR: Docker network proxy-net does not exist.' >&2
  exit 1
fi
MIHOMO_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy-net"}}{{.IPAddress}}{{end}}' "$MIHOMO_CONTAINER")"
if [ -z "$MIHOMO_IP" ]; then
  echo 'ERROR: Mihomo is not attached to proxy-net (or its name differs).' >&2
  exit 1
fi

PROXY="http://${MIHOMO_IP}:${MIHOMO_PORT}"
echo "Mihomo proxy for build RUN steps: ${PROXY}"
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsS -o /dev/null --connect-timeout 5 --max-time 20 --proxy "$PROXY" https://pypi.org/simple/; then
    echo 'ERROR: Host cannot use Mihomo proxy. Check mixed-port, allow-lan, bind-address and proxy-net rules.' >&2
    exit 1
  fi
  echo 'Mihomo HTTP proxy connectivity OK.'
else
  echo 'WARNING: curl is not installed on host; proxy preflight was skipped.' >&2
fi

echo 'NOTE: Pulling the Python FROM image requires a separate Docker daemon/BuildKit proxy.'
echo '      Remove the failing docker.ketches.cn registry mirror before retrying.'
EASYADB_BUILD_PROXY="$PROXY" docker compose up -d --build
