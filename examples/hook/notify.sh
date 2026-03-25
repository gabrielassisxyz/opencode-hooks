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
PROJECT_NAME="${PROJECT_DIR##*/}"

BRANCH_NAME=""
if command -v git >/dev/null 2>&1 && [ -n "$PROJECT_DIR" ]; then
  BRANCH_NAME="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

if [ -n "$BRANCH_NAME" ] && [ "$BRANCH_NAME" != "HEAD" ]; then
  SUBTITLE_DEFAULT="${PROJECT_NAME}:${BRANCH_NAME}"
else
  SUBTITLE_DEFAULT="$PROJECT_NAME"
fi

FILE_COUNT="$(python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except Exception:
    print(0)
    raise SystemExit

files = payload.get("files") or []
print(len([f for f in files if isinstance(f, str) and f.strip()]))
' <<< "$INPUT")"

FIRST_FILE="$(python3 -c '
import json, sys
try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit

for value in payload.get("files") or []:
    if isinstance(value, str) and value.strip():
        print(value)
        break
' <<< "$INPUT")"

TITLE="${OPENCODE_NOTIFY_TITLE:-OpenCode Hook}"
PROJECT_NAME="${OPENCODE_NOTIFY_PROJECT_NAME:-$PROJECT_NAME}"
SUBTITLE="${OPENCODE_NOTIFY_SUBTITLE:-$SUBTITLE_DEFAULT}"

if [ -n "$SESSION_ID" ]; then
  MESSAGE="Session ${SESSION_ID} is idle"
else
  MESSAGE="Session is idle"
fi

MESSAGE="${OPENCODE_NOTIFY_MESSAGE:-$MESSAGE}"

send_terminal_notification() {
  terminal-notifier -title "$TITLE" -subtitle "$SUBTITLE" -message "$MESSAGE" >/dev/null 2>>"$DEBUG_LOG"
}

send_macos_notification() {
  osascript - "$TITLE" "$MESSAGE" "$SUBTITLE" >/dev/null 2>>"$DEBUG_LOG" <<'APPLESCRIPT'
on run argv
  set notificationTitle to item 1 of argv
  set notificationMessage to item 2 of argv
  set notificationSubtitle to item 3 of argv

  if notificationSubtitle is equal to "" then
    display notification notificationMessage with title notificationTitle
  else
    display notification notificationMessage with title notificationTitle subtitle notificationSubtitle
  end if
end run
APPLESCRIPT
}

send_linux_notification() {
  local body="$MESSAGE"
  if [ -n "$PROJECT_NAME" ]; then
    body="$MESSAGE ($PROJECT_NAME)"
  fi
  notify-send "$TITLE" "$body" >/dev/null 2>&1
}

if command -v terminal-notifier >/dev/null 2>&1; then
  debug "sending terminal-notifier notification title=$TITLE subtitle=$SUBTITLE message=$MESSAGE"
  if send_terminal_notification; then
    debug "terminal-notifier notification sent"
  else
    debug "terminal-notifier notification failed"
  fi
elif command -v osascript >/dev/null 2>&1; then
  debug "sending macOS notification title=$TITLE subtitle=$SUBTITLE message=$MESSAGE"
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
