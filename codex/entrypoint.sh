#!/bin/sh
set -eu

: "${CODEX_HOME:=/codex-home}"
: "${CODEX_HOME_MAX_BYTES:=536870912}"
: "${CODEX_HOME_CHECK_INTERVAL_SECONDS:=30}"
: "${CODEX_APP_SERVER_TOKEN:?CODEX_APP_SERVER_TOKEN is required}"

case "$CODEX_HOME_MAX_BYTES" in
  *[!0-9]* | "")
    echo "CODEX_HOME_MAX_BYTES must be a positive integer" >&2
    exit 64
    ;;
esac

codex_home_bytes() {
  du -sb "$CODEX_HOME" | awk '{print $1}'
}

check_codex_home_size() {
  used_bytes=$(codex_home_bytes)
  if [ "$used_bytes" -gt "$CODEX_HOME_MAX_BYTES" ]; then
    echo "CODEX_HOME uses ${used_bytes} bytes; limit is ${CODEX_HOME_MAX_BYTES} bytes" >&2
    return 1
  fi
}

if [ "${CODEX_HOME_QUOTA_BYPASS:-0}" != "1" ]; then
  check_codex_home_size || exit 70
fi

umask 077
token_file=/tmp/codex-app-server-token
printf '%s\n' "$CODEX_APP_SERVER_TOKEN" >"$token_file"

codex "$@" \
  --ws-auth capability-token \
  --ws-token-file "$token_file" \
  -c check_for_update_on_startup=false \
  -c analytics.enabled=false \
  -c history.max_bytes=8388608 &
codex_pid=$!

stop_codex() {
  kill -TERM "$codex_pid" 2>/dev/null || true
}

trap stop_codex INT TERM HUP

if [ "${CODEX_HOME_QUOTA_BYPASS:-0}" != "1" ]; then
  (
    while kill -0 "$codex_pid" 2>/dev/null; do
      sleep "$CODEX_HOME_CHECK_INTERVAL_SECONDS"
      if ! check_codex_home_size; then
        echo "Stopping Codex before its persistent volume grows further" >&2
        kill -TERM "$codex_pid" 2>/dev/null || true
        exit 70
      fi
    done
  ) &
  quota_pid=$!
else
  quota_pid=
fi

set +e
wait "$codex_pid"
codex_status=$?
set -e

if [ -n "$quota_pid" ]; then
  kill -TERM "$quota_pid" 2>/dev/null || true
  wait "$quota_pid" 2>/dev/null || true
fi

exit "$codex_status"
