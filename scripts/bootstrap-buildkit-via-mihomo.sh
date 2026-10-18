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
. scripts/proxy-config.sh

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "BuildKit image already cached: $IMAGE"
  exit 0
fi

for command in docker curl tar sha256sum uname mktemp awk cp chmod; do
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
. scripts/proxy-host.sh

case "$(uname -m)" in
  x86_64|amd64) CRANE_ARCH=x86_64; PLATFORM=linux/amd64 ;;
  aarch64|arm64) CRANE_ARCH=arm64; PLATFORM=linux/arm64 ;;
  *) echo 'ERROR: bootstrap currently supports Linux amd64 and arm64 only.' >&2; exit 1 ;;
esac

echo "[1/5] Checking authenticated Mihomo proxy from FNOS host (credentials hidden) ..."
# curl may return exit 56 on a 407; inspect CONNECT status even on failure.
STATUS="$(curl -sS --connect-timeout 8 --max-time 25 --noproxy '' \
  --proxy "$HOST_PROXY" -o /dev/null -w '%{http_connect}:%{http_code}' \
  https://registry-1.docker.io/v2/)" && CURL_RESULT=0 || CURL_RESULT=$?
case "$STATUS" in
  200:401|200:200|200:404) echo "Docker Registry reachable via Mihomo (CONNECT 200; registry status ${STATUS#*:})." ;;
  407:*|*:407)
    echo 'ERROR: HTTP 407 Proxy Authentication Required: check the account and URL-encoded password in .env EASYADB_BUILD_PROXY.' >&2
    echo 'Use %40 for @ in the password. The proxy must be http://USER:PASSWORD@mihomo:7890.' >&2
    exit 1 ;;
  *)
    echo "ERROR: registry proxy check failed (curl exit $CURL_RESULT, HTTP status $STATUS)." >&2
    echo 'Check Mihomo authentication, upstream connectivity and proxy rules.' >&2
    exit 1 ;;
esac

# Keep large image downloads on the project/data filesystem rather than
# assuming FNOS /tmp has enough space.
CACHE_DIR="${EASYADB_BOOTSTRAP_CACHE:-./.cache}"
mkdir -p "$CACHE_DIR"
TMP="$(mktemp -d "$CACHE_DIR/buildkit.XXXXXXXX")"
EXEC_TMP=''
trap 'rm -rf "$TMP" "$EXEC_TMP"' EXIT
trap 'exit 1' HUP INT TERM

# FNOS data volumes may use "noexec". Keep the potentially large image tar on
# the data volume, but put ONLY the verified crane binary on an executable FS.
# chmod +x cannot override a noexec mount, so actually try executing a copy of
# /bin/true before choosing a temporary directory.
if [ -x /bin/true ]; then
  PROBE_BIN=/bin/true
elif [ -x /usr/bin/true ]; then
  PROBE_BIN=/usr/bin/true
else
  echo 'ERROR: cannot find /bin/true or /usr/bin/true to test executable temp storage.' >&2
  exit 1
fi
if [ -n "${EASYADB_EXEC_TMP:-}" ]; then
  set -- "$EASYADB_EXEC_TMP"
else
  set -- /tmp /var/tmp /root
fi
for CANDIDATE do
  [ -d "$CANDIDATE" ] && [ -w "$CANDIDATE" ] || continue
  CANDIDATE_DIR="$(mktemp -d "$CANDIDATE/easyadb-crane.XXXXXXXX" 2>/dev/null)" || continue
  if cp "$PROBE_BIN" "$CANDIDATE_DIR/exec-probe" &&
     chmod 700 "$CANDIDATE_DIR/exec-probe" &&
     "$CANDIDATE_DIR/exec-probe" >/dev/null 2>&1; then
    EXEC_TMP="$CANDIDATE_DIR"
    rm -f "$EXEC_TMP/exec-probe"
    break
  fi
  rm -rf "$CANDIDATE_DIR"
done
if [ -z "$EXEC_TMP" ]; then
  echo 'ERROR: no writable, executable temporary directory available (FNOS may use noexec).' >&2
  echo 'Set EASYADB_EXEC_TMP to an existing writable directory on an exec-capable filesystem and retry.' >&2
  echo 'Do not remount your FNOS data volume with exec just for this script.' >&2
  exit 1
fi
echo "Crane executable will run from $EXEC_TMP (image tar stays in project cache)."

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
tar -xzf "$TMP/$ARCHIVE" -C "$EXEC_TMP" crane
chmod 700 "$EXEC_TMP/crane"

echo "[3/5] Downloading $IMAGE ($PLATFORM) through Mihomo ..."
# Crane talks directly to the registry via the host-side HTTP proxy.
# Unlike docker pull, it does not ask Docker daemon to fetch remote layers.
HTTP_PROXY="$HOST_PROXY" HTTPS_PROXY="$HOST_PROXY" \
http_proxy="$HOST_PROXY" https_proxy="$HOST_PROXY" \
NO_PROXY='' no_proxy='' \
"$EXEC_TMP/crane" --platform "$PLATFORM" pull "$IMAGE" "$TMP/buildkit.tar"

echo "[4/5] Importing image into local Docker (no daemon network pull) ..."
docker load -i "$TMP/buildkit.tar"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "ERROR: docker load completed but $IMAGE is not present." >&2
  exit 1
fi

echo "[5/5] Ready: $IMAGE"
echo "Now run: sh scripts/build-with-mihomo.sh"
