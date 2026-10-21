#!/bin/sh
set -eu

# FNOS/Linux cron scheduler for the EXISTING EasyADB deployment script.
# Usage: sudo sh scripts/scheduled-deploy.sh start 15m [--no-proxy]
#        sudo sh scripts/scheduled-deploy.sh status|stop|logs
# The crontab survives SSH logout and NAS reboot (provided cron is running).
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
SELF="$ROOT/scripts/scheduled-deploy.sh"
STATE_DIR="$ROOT/data/storage"
CONFIG="$STATE_DIR/.easyadb-schedule"
LAST_CHECK="$STATE_DIR/.easyadb-schedule-last-check"
LAST_RESULT="$STATE_DIR/.easyadb-schedule-last-result"
LOG="$STATE_DIR/.easyadb-schedule.log"
LOCK="$STATE_DIR/.easyadb-schedule.lock"
MARKER="EASYADB_SCHEDULED_DEPLOY:$ROOT"

usage() {
  echo 'Usage: sudo sh scripts/scheduled-deploy.sh start <interval> [--no-proxy]'
  echo '       sudo sh scripts/scheduled-deploy.sh status | stop | logs'
  echo '  Examples: start 15m, start 2h, start 1d (bare 15 = minutes)'
  echo '  Interval: 1..10080 minutes. Default deployment uses Mihomo.'
}

# Cron interprets % specially; quoted paths cannot contain single quotes.
case "$ROOT" in
  *"'"*|*%*|*'
'*) echo 'ERROR: project path cannot contain quotes, percent signs or newlines.' >&2; exit 2 ;;
esac

read_crontab() { crontab -l 2>/dev/null || :; }
installed() { read_crontab | grep -F "$MARKER" >/dev/null 2>&1; }
# Filter only this project's uniquely marked entry, never other cron tasks.
without_ours() { read_crontab | grep -Fv "$MARKER" || :; }
require_cron() {
  command -v crontab >/dev/null 2>&1 || {
    echo 'ERROR: crontab is required. Enable/install cron on the NAS first.' >&2; exit 1;
  }
}
parse_interval() {
  input="$1"
  case "$input" in
    *m) digits="${input%m}"; multiplier=1 ;;
    *h) digits="${input%h}"; multiplier=60 ;;
    *d) digits="${input%d}"; multiplier=1440 ;;
    *) digits="$input"; multiplier=1 ;;
  esac
  case "$digits" in ''|*[!0-9]*) echo 'ERROR: interval must be a number followed by m, h or d.' >&2; exit 2 ;; esac
  [ "${#digits}" -le 5 ] || { echo 'ERROR: interval too large.' >&2; exit 2; }
  digits="$(printf '%s' "$digits" | sed 's/^0*//')"
  digits="${digits:-0}"
  minutes=$((digits * multiplier))
  if [ "$minutes" -lt 1 ] || [ "$minutes" -gt 10080 ]; then
    echo 'ERROR: interval must be between 1 minute and 7 days.' >&2; exit 2
  fi
}
deployment_branch() {
  # Existing M3 schedules follow the same V4 target as manual updates.
  case "$1" in
    feat/m3-openwrt-discovery) printf '%s\n' 'refactor/v4-frontend-standards' ;;
    *) printf '%s\n' "$1" ;;
  esac
}
valid_branch() {
  case "$1" in
    feat/m2-web-control|feat/display-mode-lab|feat/m3-openwrt-discovery|refactor/foundation-v1|refactor/session-v2|refactor/v2-session-governance|refactor/v4-frontend-standards) ;;
    *) echo 'ERROR: unsupported scheduled branch; use an explicitly allowed EasyADB branch.' >&2; exit 2 ;;
  esac
}
read_config() {
  [ -f "$CONFIG" ] || return 1
  INTERVAL="$(sed -n '1p' "$CONFIG")"
  MODE="$(sed -n '2p' "$CONFIG")"
  GIT_UID="$(sed -n '3p' "$CONFIG")"
  BRANCH="$(sed -n '4p' "$CONFIG")"
  case "$INTERVAL" in ''|*[!0-9]*) return 1 ;; esac
  case "$GIT_UID" in ''|*[!0-9]*) return 1 ;; esac
  case "$MODE" in proxy|direct) ;; *) return 1 ;; esac
  case "$BRANCH" in
    feat/m2-web-control|feat/display-mode-lab|feat/m3-openwrt-discovery|refactor/foundation-v1|refactor/session-v2|refactor/v2-session-governance|refactor/v4-frontend-standards) ;;
    *) return 1 ;;
  esac
  BRANCH="$(deployment_branch "$BRANCH")"
  [ "$INTERVAL" -ge 1 ] && [ "$INTERVAL" -le 10080 ]
}
git_owner() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ]; then
    sudo -H -u "#${SUDO_UID}" git "$@"
  else
    git "$@"
  fi
}

case "${1:-}" in
  start)
    [ "$#" -ge 2 ] && [ "$#" -le 3 ] || { usage; exit 2; }
    parse_interval "$2"
    MODE=proxy
    if [ "$#" -eq 3 ]; then
      [ "$3" = --no-proxy ] || { usage; exit 2; }
      MODE=direct
    fi
    require_cron
    command -v flock >/dev/null 2>&1 || {
      echo 'ERROR: flock is required to prevent overlapping deployments.' >&2; exit 1;
    }
    BRANCH="${EASYADB_SOURCE_BRANCH:-$(git_owner symbolic-ref --quiet --short HEAD || :)}"
    valid_branch "$BRANCH"
    BRANCH="$(deployment_branch "$BRANCH")"
    GIT_UID="$(id -u)"
    if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ]; then
      GIT_UID="$SUDO_UID"
    fi
    # Verify the original Git login user can access this checkout.
    git_owner rev-parse --is-inside-work-tree >/dev/null || {
      echo 'ERROR: original Git login user cannot access this checkout.' >&2; exit 1;
    }
    mkdir -p "$STATE_DIR"
    # Do not alter permissions on the existing bind-mounted data directory.
    : >> "$LOG"
    chmod 600 "$LOG"
    tmp="$CONFIG.tmp.$$"
    printf '%s\n%s\n%s\n%s\n' "$minutes" "$MODE" "$GIT_UID" "$BRANCH" > "$tmp"
    chmod 600 "$tmp"
    line="* * * * * /bin/sh '$SELF' run >> '$LOG' 2>&1 # $MARKER"
    # Read the old crontab COMPLETELY before starting crontab -.
    # A simultaneous crontab -l / crontab - can otherwise race and drop
    # unrelated jobs, even though our filtered entry is unique.
    previous_table="$(without_ours)"
    if ! { if [ -n "$previous_table" ]; then printf '%s\n' "$previous_table"; fi
           printf '%s\n' "$line"; } | crontab -; then
      rm -f "$tmp"
      echo 'ERROR: could not install scheduled deployment into crontab.' >&2
      exit 1
    fi
    mv -f "$tmp" "$CONFIG"
    date +%s > "$LAST_CHECK"
    printf '%s\n' 'scheduled (waiting for first interval)' > "$LAST_RESULT"
    chmod 600 "$LAST_CHECK" "$LAST_RESULT"
    echo "Enabled: every $minutes minute(s), branch $BRANCH, mode $MODE."
    echo "Status: sudo sh scripts/scheduled-deploy.sh status"
    echo "Log: $LOG"
    echo 'Note: cron/crond service must be enabled on the NAS.'
    ;;
  status)
    require_cron
    if installed; then echo 'Status: enabled (crontab entry installed)'
    else echo 'Status: disabled (no managed crontab entry)'; fi
    if read_config; then
      echo "Interval: $INTERVAL minute(s)"
      echo "Branch: $BRANCH"
      echo "Build mode: $MODE"
      echo "Git login UID: $GIT_UID"
      [ ! -f "$LAST_CHECK" ] || echo "Last check epoch: $(cat "$LAST_CHECK")"
      [ ! -f "$LAST_RESULT" ] || echo "Last result: $(cat "$LAST_RESULT")"
      marker="$STATE_DIR/.easyadb-last-deployed-tree"
      [ ! -f "$marker" ] || echo "Last successful deployed Git tree: $(cat "$marker")"
    fi
    echo "Log: $LOG"
    ;;
  stop)
    [ "$#" -eq 1 ] || { usage; exit 2; }
    require_cron
    if installed; then
      previous_table="$(without_ours)"
      if [ -n "$previous_table" ]; then
        printf '%s\n' "$previous_table" | crontab -
      else
        printf '' | crontab -
      fi
    fi
    echo 'Disabled: future scheduled checks stopped (an already running build is not interrupted).'
    ;;
  logs)
    [ "$#" -eq 1 ] || { usage; exit 2; }
    if [ -f "$LOG" ]; then tail -n 60 "$LOG"; else echo 'No scheduled deployment logs yet.'; fi
    ;;
  run)
    # Cron invokes this once per minute. A nonblocking lock prevents overlap
    # with a previous long build, while the interval gate avoids Git polling.
    [ -f "$CONFIG" ] || exit 0
    installed || exit 0
    flock -n "$LOCK" /bin/sh "$SELF" run-locked || :
    ;;
  run-locked)
    read_config || { echo 'ERROR: invalid scheduled deployment state.' >&2; exit 1; }
    installed || exit 0
    now="$(date +%s)"
    previous="$(cat "$LAST_CHECK" 2>/dev/null || echo 0)"
    case "$previous" in ''|*[!0-9]*) previous=0 ;; esac
    [ "$now" -ge $((previous + INTERVAL * 60)) ] || exit 0
    # Record the attempt, not successful deployment. A failed build leaves
    # the deployed-tree marker unchanged and is retried at the next interval.
    printf '%s\n' "$now" > "$LAST_CHECK"
    echo "[$(date)] Scheduled Git check: $BRANCH / $MODE"
    marker="$STATE_DIR/.easyadb-last-deployed-tree"
    prior="$(cat "$marker" 2>/dev/null || :)"
    if [ "$MODE" = direct ]; then
      if SUDO_UID="$GIT_UID" EASYADB_SOURCE_BRANCH="$BRANCH" /bin/sh scripts/build-with-mihomo.sh --if-changed --no-proxy; then rc=0; else rc=$?; fi
    else
      if SUDO_UID="$GIT_UID" EASYADB_SOURCE_BRANCH="$BRANCH" /bin/sh scripts/build-with-mihomo.sh --if-changed; then rc=0; else rc=$?; fi
    fi
    if [ "$rc" -eq 0 ]; then
      after="$(cat "$marker" 2>/dev/null || :)"
      if [ "$prior" = "$after" ]; then outcome='no Git file changes / Docker skipped'
      else outcome='updated / deployment successful'; fi
    else
      outcome="FAILED (exit $rc); previous deployed version retained for retry"
    fi
    printf '%s\n' "$outcome" > "$LAST_RESULT"
    echo "[$(date)] $outcome"
    exit "$rc"
    ;;
  --help|-h|help) usage ;;
  *) usage; exit 2 ;;
esac
