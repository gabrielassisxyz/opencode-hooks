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

json_quote() {
  python3 -c 'import json, sys; print(json.dumps(sys.stdin.read()))'
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
  local quoted_message quoted_title quoted_subtitle
  quoted_message="$(printf '%s' "$MESSAGE" | json_quote)"
  quoted_title="$(printf '%s' "$TITLE" | json_quote)"
  quoted_subtitle="$(printf '%s' "$PROJECT_NAME" | json_quote)"
  osascript -e "display notification ${quoted_message} with title ${quoted_title} subtitle ${quoted_subtitle}" >/dev/null 2>&1
}

send_linux_notification() {
  local body="$MESSAGE"
  if [ -n "$PROJECT_NAME" ]; then
    body="$MESSAGE ($PROJECT_NAME)"
  fi
  notify-send "$TITLE" "$body" >/dev/null 2>&1
}

if command -v osascript >/dev/null 2>&1; then
  send_macos_notification || true
elif command -v notify-send >/dev/null 2>&1; then
  send_linux_notification || true
else
  printf '[notify-hook] %s: %s\n' "$TITLE" "$MESSAGE" >&2
fi

exit 0
