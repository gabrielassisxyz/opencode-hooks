#!/usr/bin/env bash
set -euo pipefail

# block-commands.sh — OpenCode hook example for blocking selected bash commands.
#
# Designed for tool.before.bash hooks. Edit BLOCKED_COMMANDS below to control
# which commands are denied.
#
# Usage:
#   hooks:
#     - event: tool.before.bash
#       # Add action: stop if a blocked command should also abort the active
#       # OpenCode session instead of only blocking this bash tool call.
#       # Without action: stop, exit 2 blocks only the current tool invocation.
#       action: stop
#       actions:
#         - bash: "$HOME/.config/opencode/hook/block-commands.sh"
#
# Notes:
# - The script reads the OpenCode hook JSON from stdin.
# - It inspects .tool_args.command.
# - Exit status 2 blocks the bash tool invocation.
# - To stop the whole session too, pair this script with `action: stop` in
#   hooks.yaml on the surrounding tool.before hook.

DEBUG_LOG="${OPENCODE_BLOCK_COMMANDS_LOG:-/tmp/opencode-block-commands.log}"

debug() {
  if [ "${OPENCODE_BLOCK_COMMANDS_DEBUG:-0}" = "1" ]; then
    printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >> "$DEBUG_LOG"
  fi
}

# Hardcoded blocklist. Add one command per line.
# A command is blocked when the bash command starts with the listed value,
# followed by end-of-string or whitespace.
# Examples:
#   "git push"
#   "git push --force"
#   "rm -rf"
BLOCKED_COMMANDS=(
  "git push"
  "git push --force"
)

INPUT="$(cat 2>/dev/null || true)"
[ -z "$INPUT" ] && exit 0

COMMAND="$(python3 -c '
import json, sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool_args = payload.get("tool_args") or {}
command = tool_args.get("command", "")
print(command if isinstance(command, str) else "")
' <<< "$INPUT")"

[ -z "$COMMAND" ] && exit 0

debug "checking command: $COMMAND"

command_matches() {
  local command="$1"
  local blocked="$2"

  case "$command" in
    "$blocked")
      return 0
      ;;
    "$blocked"\ *)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

for blocked in "${BLOCKED_COMMANDS[@]}"; do
  if command_matches "$COMMAND" "$blocked"; then
    debug "blocked by command: $blocked"
    echo "Blocked by block-commands.sh: $COMMAND" >&2
    exit 2
  fi
done

debug "allowed command"
exit 0
