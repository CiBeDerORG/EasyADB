#!/bin/sh
set -eu

# Legacy M3 deployment bridge. Validate the original options before Git, then
# let the freshly selected V4 builder own runtime checks, Docker and markers.
IF_CHANGED=0
SEEN_DIRECT=0
for arg do
  case "$arg" in
    --no-proxy)
      if [ "$SEEN_DIRECT" = 1 ]; then echo 'ERROR: duplicate --no-proxy' >&2; exit 2; fi
      SEEN_DIRECT=1 ;;
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
DEPLOY_MARKER=data/storage/.easyadb-last-deployed-tree
deploy_git() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ]; then
    sudo -H -u "#${SUDO_UID}" git "$@"
  else
    git "$@"
  fi
}
git_tree() { deploy_git rev-parse 'HEAD^{tree}' 2>/dev/null || :; }
# Keep the first scheduled baseline; never overwrite an existing success marker.
if [ "$IF_CHANGED" = 1 ] && [ ! -f "$DEPLOY_MARKER" ]; then
  before="$(git_tree)"
  if [ -n "$before" ]; then
    mkdir -p data/storage
    printf '%s\n' "$before" > "$DEPLOY_MARKER.tmp.$$"
    mv -f "$DEPLOY_MARKER.tmp.$$" "$DEPLOY_MARKER"
  fi
fi

# An old M3 builder sets EASYADB_UPDATED=1 after fetching this bridge commit.
# Always perform the V4 transition here, even with that inherited marker.
# Git failure stops before re-exec or any Docker work. The V4 builder validates
# the existing .env; this migration never rewrites it or deploys the old MSE code.
sh scripts/update-m2.sh
EASYADB_SOURCE_BRANCH=refactor/v4-frontend-standards
EASYADB_UPDATED=1
export EASYADB_SOURCE_BRANCH EASYADB_UPDATED
exec sh scripts/build-with-mihomo.sh "$@"
