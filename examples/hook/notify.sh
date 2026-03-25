#!/usr/bin/env bash
set -euo pipefail

# notify.sh — OpenCode hook example for desktop notifications.
#
# Designed as a simple, generic example with no Superset-specific behavior.
# This version only reacts to session.idle events.
#
# Usage:
#   hooks:
#     - event: session.idle
#       scope: main
#       actions:
#         - bash: "$HOME/.config/opencode/hook/notify.sh"

INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0

DEBUG_LOG="${OPENCODE_NOTIFY_LOG:-/tmp/opencode-notify.log}"

debug() {
  if [ "${OPENCODE_NOTIFY_DEBUG:-0}" = "1" ]; then
    printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >> "$DEBUG_LOG"
  fi
}

json_get() {
  local key="$1"
  python3 -c '
import json, sys

key = sys.argv[1]
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

value = payload.get(key, "")
print(value if isinstance(value, str) else "")
' "$key" <<< "$INPUT"
}

EVENT="$(json_get event)"
[ "$EVENT" = "session.idle" ] || exit 0

SESSION_ID="$(json_get session_id)"
CWD="$(json_get cwd)"
PROJECT_DIR="${OPENCODE_PROJECT_DIR:-${CWD:-}}"
PROJECT_NAME="${OPENCODE_NOTIFY_SUBTITLE:-${PROJECT_DIR##*/}}"

TITLE="${OPENCODE_NOTIFY_TITLE:-OpenCode}"
MESSAGE="${OPENCODE_NOTIFY_MESSAGE:-Session is idle}"

if [ -n "$SESSION_ID" ]; then
  MESSAGE="$MESSAGE — ${SESSION_ID:0:8}"
fi

send_macos_notification() {
  TITLE="$TITLE" MESSAGE="$MESSAGE" PROJECT_NAME="$PROJECT_NAME" python3 - <<'PY' | osascript >/dev/null 2>>"$DEBUG_LOG"
import json
import os

title = json.dumps(os.environ.get("TITLE", "OpenCode"))
message = json.dumps(os.environ.get("MESSAGE", "Session is idle"))
subtitle = json.dumps(os.environ.get("PROJECT_NAME", ""))

if os.environ.get("PROJECT_NAME"):
    print(f"display notification {message} with title {title} subtitle {subtitle}")
else:
    print(f"display notification {message} with title {title}")
PY
}

send_linux_notification() {
  local body="$MESSAGE"
  if [ -n "$PROJECT_NAME" ]; then
    body="$MESSAGE ($PROJECT_NAME)"
  fi
  notify-send "$TITLE" "$body" >/dev/null 2>&1
}

if command -v osascript >/dev/null 2>&1; then
  debug "sending macOS notification title=$TITLE subtitle=$PROJECT_NAME message=$MESSAGE"
  if send_macos_notification; then
    debug "macOS notification sent"
  else
    debug "macOS notification failed"
  fi
elif command -v notify-send >/dev/null 2>&1; then
  debug "sending Linux notification title=$TITLE message=$MESSAGE"
  if send_linux_notification; then
    debug "Linux notification sent"
  else
    debug "Linux notification failed"
  fi
else
  debug "no supported notification command found"
  printf '[notify-hook] %s: %s\n' "$TITLE" "$MESSAGE" >&2
fi

exit 0
