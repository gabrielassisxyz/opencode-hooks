#!/usr/bin/env bash
set -euo pipefail

# block-commands.sh — OpenCode hook example for blocking selected bash commands.
#
# Designed for tool.before.bash hooks. Edit BLOCKED_PATTERNS below to control
# which commands are denied.
#
# Usage:
#   hooks:
#     - event: tool.before.bash
#       actions:
#         - bash: "$HOME/.config/opencode/hook/block-commands.sh"
#
# Notes:
# - The script reads the OpenCode hook JSON from stdin.
# - It inspects .tool_args.command.
# - Exit status 2 blocks the bash tool invocation.

DEBUG_LOG="${OPENCODE_BLOCK_COMMANDS_LOG:-/tmp/opencode-block-commands.log}"

debug() {
  if [ "${OPENCODE_BLOCK_COMMANDS_DEBUG:-0}" = "1" ]; then
    printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >> "$DEBUG_LOG"
  fi
}

# Hardcoded blocklist. Add one regex pattern per line.
# Patterns are tested against the full bash command string.
BLOCKED_PATTERNS=(
  '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)'
  '(^|[[:space:]])git[[:space:]]+push[[:space:]].*--force([[:space:]]|$)'
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

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if printf '%s' "$COMMAND" | grep -Eq "$pattern"; then
    debug "blocked by pattern: $pattern"
    echo "Blocked by block-commands.sh: $COMMAND" >&2
    exit 2
  fi
done

debug "allowed command"
exit 0
