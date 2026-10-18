#!/bin/sh
set -eu

# Update only the EasyADB M1 branch, before doing any Docker work.
# Keep Git under the original login user: root may not have their GitHub SSH key.
TARGET_BRANCH=feat/m1-multi-device

git_as_owner() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    sudo -H -u "$SUDO_USER" git "$@"
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

CURRENT="$(git_as_owner symbolic-ref --quiet --short HEAD || true)"
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
