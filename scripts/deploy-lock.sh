#!/bin/sh
# Sourced after entering the checkout. One lock covers Git update, script
# re-entry, Docker build/start and the successful-deployment marker.
acquire_deploy_lock() {
  command -v flock >/dev/null 2>&1 || {
    echo 'ERROR: flock is required to prevent overlapping deployments.' >&2
    return 1
  }
  deploy_lock_path="$(pwd -P)/data/storage/.easyadb-deploy.lock"
  mkdir -p data/storage || return 1
  # Linux/FNOS: reuse the same open file description across exec and the
  # scheduler's child shell. An environment flag alone cannot prove ownership.
  # Never reopen an inherited descriptor: that would drop/reacquire its lock.
  if [ ! "$deploy_lock_path" -ef /proc/self/fd/9 ]; then
    exec 9>"$deploy_lock_path"
  fi
  if flock -n 9; then
    return 0
  else
    deploy_lock_status=$?
    # Reserve a distinct exit status so cron can retry a busy checkout next
    # minute without consuming its interval or reporting a failed deployment.
    [ "$deploy_lock_status" -ne 1 ] || return 75
    return "$deploy_lock_status"
  fi
}
