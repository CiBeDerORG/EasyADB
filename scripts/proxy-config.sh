#!/bin/sh
# Shared, non-evaluating reader for the project's build proxy setting.
# Sourced by build-with-mihomo.sh and bootstrap-buildkit-via-mihomo.sh.
# Read .env as data; do NOT source or eval it (may contain credentials).
if [ -z "${EASYADB_BUILD_PROXY:-}" ] && [ -f .env ]; then
  EASYADB_BUILD_PROXY="$(sed -n 's/^[[:space:]]*EASYADB_BUILD_PROXY[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | tr -d '\r')"
fi
PROXY="${EASYADB_BUILD_PROXY:-http://mihomo:7890}"
# Optional surrounding quotes in .env; URI components themselves need percent encoding.
case "$PROXY" in
  \"*\") PROXY="${PROXY#\"}"; PROXY="${PROXY%\"}" ;;
  \'*\') PROXY="${PROXY#\'}"; PROXY="${PROXY%\'}" ;;
esac
case "$PROXY" in
  http://mihomo:7890|http://*@mihomo:7890) ;;
  *)
    echo 'ERROR: EASYADB_BUILD_PROXY must be http://mihomo:7890 or http://USER:URL_ENCODED_PASSWORD@mihomo:7890.' >&2
    echo 'Percent-encode special characters in credentials (e.g. @ becomes %40).' >&2
    exit 1
    ;;
esac
# Keep the URL private. Never log it: it can embed proxy credentials.
EASYADB_BUILD_PROXY="$PROXY"
export EASYADB_BUILD_PROXY
