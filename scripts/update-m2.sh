#!/bin/sh
set -eu

# Update a known EasyADB development branch before doing Docker work.
# Keep the historical M2 default only for an empty source (e.g. detached HEAD).
# Never silently switch an unrecognized checked-out branch to old M2.
# EASYADB_SOURCE_BRANCH is an optional, strict allowlist override.
# Keep Git under the original login user: root may not have their GitHub SSH key.
TARGET_BRANCH=feat/m2-web-control

git_as_owner() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ]; then
    # SUDO_UID also works if the login name is entirely numeric.
    sudo -H -u "#${SUDO_UID}" git "$@"
  else
    git "$@"
  fi
}

if ! command -v git >/dev/null 2>&1; then
  echo 'ERROR: Git is required for automatic updates.' >&2
  exit 1
fi

if ! git_as_owner rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo 'ERROR: cannot access this repository using the original login user.' >&2
  echo 'Check repository ownership and GitHub SSH access; no Docker changes made.' >&2
  exit 1
fi

# Current checkout is read as the original login user (same owner as fetch).
# For unattended builds preserve the explicit display-lab checkout by default.
CURRENT="$(git_as_owner symbolic-ref --quiet --short HEAD || true)"
SOURCE="${EASYADB_SOURCE_BRANCH:-$CURRENT}"
case "$SOURCE" in
  feat/display-mode-lab)
    TARGET_BRANCH=feat/display-mode-lab ;;
  feat/m3-openwrt-discovery)
    TARGET_BRANCH=feat/m3-openwrt-discovery ;;
  refactor/foundation-v1|refactor/session-v2|refactor/v2-session-governance)
    TARGET_BRANCH="$SOURCE" ;;
  feat/m2-web-control|"")
    TARGET_BRANCH=feat/m2-web-control ;;
  *)
    echo "ERROR: unsupported source branch $SOURCE; refusing implicit checkout switch." >&2
    exit 2 ;;
esac

# Ignore .env, data and .cache via .gitignore. Never discard user changes.
if [ -n "$(git_as_owner status --porcelain --untracked-files=normal)" ]; then
  echo 'ERROR: local Git changes or untracked files exist; refusing to switch or pull.' >&2
  echo 'Commit, stash or move them manually. Your .env and data are ignored and preserved.' >&2
  exit 1
fi

echo "Checking origin/$TARGET_BRANCH using the login user's Git credentials..."
git_as_owner fetch origin

if ! git_as_owner show-ref --verify --quiet "refs/remotes/origin/$TARGET_BRANCH"; then
  echo "ERROR: remote branch origin/$TARGET_BRANCH does not exist." >&2
  exit 1
fi

if [ "$CURRENT" != "$TARGET_BRANCH" ]; then
  if git_as_owner show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    git_as_owner switch "$TARGET_BRANCH"
  else
    git_as_owner switch --track -c "$TARGET_BRANCH" "origin/$TARGET_BRANCH"
  fi
fi

# No implicit merge/rebase or force reset. Stop safely on divergence.
git_as_owner pull --ff-only origin "$TARGET_BRANCH"
echo "Source ready: $TARGET_BRANCH"
