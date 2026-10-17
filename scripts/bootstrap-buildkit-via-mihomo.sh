#!/bin/sh
set -eu

# One-time Docker image bootstrap WITHOUT changing/restarting Docker daemon.
# Host cannot resolve "mihomo" (Docker DNS exists only inside proxy-net).
# Hence this host-side download uses the bridge IP only temporarily.
# BuildKit/EasyADB themselves still use http://mihomo:7890 inside proxy-net.

NETWORK=proxy-net
MIHOMO_CONTAINER="${MIHOMO_CONTAINER:-mihomo}"
MIHOMO_PORT="${MIHOMO_PORT:-7890}"
IMAGE="${BUILDKIT_IMAGE:-moby/buildkit:buildx-stable-1}"
CRANE_VERSION="${CRANE_VERSION:-v0.22.1}"

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "BuildKit image already cached: $IMAGE"
  exit 0
fi

for command in docker curl tar sha256sum uname mktemp awk; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $command" >&2
    exit 1
  fi
done

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "ERROR: existing Docker network $NETWORK was not found." >&2
  exit 1
fi
if [ "$(docker inspect -f '{{.State.Running}}' "$MIHOMO_CONTAINER" 2>/dev/null || true)" != true ]; then
  echo "ERROR: $MIHOMO_CONTAINER is not running." >&2
  exit 1
fi
MIHOMO_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy-net"}}{{.IPAddress}}{{end}}' "$MIHOMO_CONTAINER")"
if [ -z "$MIHOMO_IP" ]; then
  echo "ERROR: $MIHOMO_CONTAINER is not attached to proxy-net." >&2
  exit 1
fi
HOST_PROXY="http://${MIHOMO_IP}:${MIHOMO_PORT}"

case "$(uname -m)" in
  x86_64|amd64) CRANE_ARCH=x86_64; PLATFORM=linux/amd64 ;;
  aarch64|arm64) CRANE_ARCH=arm64; PLATFORM=linux/arm64 ;;
  *) echo 'ERROR: bootstrap currently supports Linux amd64 and arm64 only.' >&2; exit 1 ;;
esac

echo "[1/5] Checking Mihomo proxy from FNOS host ($HOST_PROXY) ..."
HTTP_CODE="$(curl -sS --connect-timeout 8 --max-time 25 --noproxy '' \
  --proxy "$HOST_PROXY" -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/)" || {
    echo 'ERROR: cannot reach Docker Hub through Mihomo. Check mixed-port: 7890, allow-lan: true and bind-address: "*".' >&2
    exit 1
  }
case "$HTTP_CODE" in
  200|401) echo "Docker Registry is reachable (HTTP $HTTP_CODE)." ;;
  *) echo "ERROR: unexpected Docker Registry HTTP $HTTP_CODE via Mihomo." >&2; exit 1 ;;
esac

# Keep large image downloads on the project/data filesystem rather than
# assuming FNOS /tmp has enough space.
CACHE_DIR="${EASYADB_BOOTSTRAP_CACHE:-./.cache}"
mkdir -p "$CACHE_DIR"
TMP="$(mktemp -d "$CACHE_DIR/buildkit.XXXXXXXX")"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 1' HUP INT TERM

BASE="https://github.com/google/go-containerregistry/releases/download/$CRANE_VERSION"
ARCHIVE="go-containerregistry_Linux_${CRANE_ARCH}.tar.gz"
echo "[2/5] Downloading official crane $CRANE_VERSION via Mihomo ..."
curl -fL --retry 4 --retry-all-errors --retry-delay 2 \
  --connect-timeout 15 --max-time 300 --noproxy '' --proxy "$HOST_PROXY" \
  "$BASE/$ARCHIVE" -o "$TMP/$ARCHIVE"
curl -fL --retry 4 --retry-all-errors --retry-delay 2 \
  --connect-timeout 15 --max-time 120 --noproxy '' --proxy "$HOST_PROXY" \
  "$BASE/checksums.txt" -o "$TMP/checksums.txt"

# Check official release checksum before executing the downloaded binary.
awk -v name="$ARCHIVE" '$2 == name || $2 == "*" name { print; found=1 } END { if (!found) exit 1 }' \
  "$TMP/checksums.txt" > "$TMP/check.txt" || {
    echo "ERROR: checksum for $ARCHIVE was not published in this release." >&2
    exit 1
  }
(cd "$TMP" && sha256sum -c check.txt)
tar -xzf "$TMP/$ARCHIVE" -C "$TMP" crane
chmod 700 "$TMP/crane"

echo "[3/5] Downloading $IMAGE ($PLATFORM) through Mihomo ..."
# Crane talks directly to the registry via the host-side HTTP proxy.
# Unlike docker pull, it does not ask Docker daemon to fetch remote layers.
HTTP_PROXY="$HOST_PROXY" HTTPS_PROXY="$HOST_PROXY" \
http_proxy="$HOST_PROXY" https_proxy="$HOST_PROXY" \
NO_PROXY='' no_proxy='' \
"$TMP/crane" --platform "$PLATFORM" pull "$IMAGE" "$TMP/buildkit.tar"

echo "[4/5] Importing image into local Docker (no daemon network pull) ..."
docker load -i "$TMP/buildkit.tar"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ERROR: docker load completed but $IMAGE is not present." >&2
  exit 1
fi

echo "[5/5] Ready: $IMAGE"
echo "Now run: sh scripts/build-with-mihomo.sh"
