#!/bin/sh
# Resolve a proxy-net hostname to the host-reachable bridge address.
# Source AFTER scripts/proxy-config.sh. Do not log HOST_PROXY: it carries credentials.
MIHOMO_CONTAINER="${MIHOMO_CONTAINER:-mihomo}"
MIHOMO_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy-net"}}{{.IPAddress}}{{end}}' "$MIHOMO_CONTAINER" 2>/dev/null)" || {
  echo 'ERROR: cannot inspect Mihomo on proxy-net.' >&2
  exit 1
}
if [ -z "$MIHOMO_IP" ]; then
  echo 'ERROR: Mihomo has no IPv4 address on proxy-net.' >&2
  exit 1
fi
case "$PROXY" in
  http://mihomo:7890)
    HOST_PROXY="http://${MIHOMO_IP}:7890"
    ;;
  http://*@mihomo:7890)
    USERINFO="${PROXY#http://}"
    USERINFO="${USERINFO%@mihomo:7890}"
    case "$USERINFO" in
      *:*@*|*@*|'')
        echo 'ERROR: URL-encode any @ in proxy username/password as %40.' >&2
        exit 1
        ;;
      *:*) ;;
      *)
        echo 'ERROR: authenticated proxy requires USER:URL_ENCODED_PASSWORD.' >&2
        exit 1
        ;;
    esac
    HOST_PROXY="http://${USERINFO}@${MIHOMO_IP}:7890"
    ;;
esac
