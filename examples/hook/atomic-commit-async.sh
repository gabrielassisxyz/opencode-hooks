#!/usr/bin/env bash
set -euo pipefail

# atomic-commit-async.sh — OpenCode hook for async atomic commits.
#
# Designed for opencode-hooks plugin with async: true on file.changed.
# The runtime serializes async hooks per event+session, so this script
# does NOT need its own queue or lock — only one instance runs at a time.
#
# Usage:
#   Hook mode: receives OpenCode file.changed JSON on stdin (with logging at tail -f /tmp/opencode-atomic-commit-debug.log).
#     hooks:
#       - event: file.changed
#         async: true
#         scope: all
#         conditions: [hasCodeChange]
#         actions:
#           - bash: "OPENCODE_ATOMIC_DEBUG=1  $HOME/.config/opencode/hook/atomic-commit-async.sh"
#
#   CLI mode:
#     atomic-commit-async.sh --each [directory] [--dry-run]
#     Commits each uncommitted file individually.
#

DRY_RUN=0
EACH_MODE=0
TARGET_DIR="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --each)    EACH_MODE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *)         TARGET_DIR="$1"; shift ;;
  esac
done

# --- Constants ---

DEBUG_LOG="/tmp/opencode-atomic-commit-debug.log"
OPENCODE_ATOMIC_DEBUG="${OPENCODE_ATOMIC_DEBUG:-${DEBUG:-}}"
if [[ -n "$OPENCODE_ATOMIC_DEBUG" && "$OPENCODE_ATOMIC_DEBUG" != "0" && "$OPENCODE_ATOMIC_DEBUG" != "false" ]]; then
  debug() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >> "$DEBUG_LOG"; }
else
  debug() { :; }
fi
###

STATE_DIR_PREFIX="/tmp/opencode-atomic-commit"
OPENCODE_COMMIT_MODEL="${OPENCODE_COMMIT_MODEL:-opencode/big-pickle}"
OPENCODE_COMMIT_AGENT="${OPENCODE_COMMIT_AGENT:-build}"
OPENCODE_CHILD_GUARD_VAR="OPENCODE_ATOMIC_COMMIT_ASYNC_CHILD"

SYSTEM_PROMPT='You are a git commit message generator. Follow this format EXACTLY:

Line 1: <imperative verb> <what changed> (max 50 chars, NO period)
Line 2: blank
Line 3+: <why/context, one bullet per line> (max 72 chars per line, prefix with "- ")

Rules:
- Line 1 MUST start with an imperative verb (Add, Fix, Refactor, Extract, Remove, Rename, Implement, Correct, Tighten, Wire, etc.)
- Line 1 must describe WHAT changed semantically, not just the filename
- Body explains WHY this change was made, not what lines changed
- NEVER use generic messages like "Update file", "WIP", "Fix stuff", "Modify code"
- NEVER mention filenames in line 1 unless the change IS about the file itself (e.g. renaming it)
- Output ONLY the commit message, nothing else — no markdown fences, no explanation
- NEVER ask questions or request clarification. You must ALWAYS output a valid commit message.
- For deletions: infer the reason from the file content and any context provided. If unsure, describe what was removed (e.g. "Remove unused auth middleware").'

# --- Utilities ---

run_with_timeout() {
  local secs="$1"; shift
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@" &
    local pid=$!
    ( sleep "$secs" && kill "$pid" 2>/dev/null ) &
    local watchdog=$!
    wait "$pid" 2>/dev/null
    local ret=$?
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null
    return $ret
  fi
}

log() { printf '%s\n' "$*"; }

ensure_relative_label() {
  local label="$1"
  [[ "$label" != /* ]] && { printf '%s' "$label"; return; }
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { basename "$label"; return; }
  python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$label" "$repo_root" 2>/dev/null || basename "$label"
}

resolve_path() {
  python3 -c "import os, sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null || echo "$1"
}

get_relpath() {
  python3 -c "import os.path, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$1" "$2" 2>/dev/null || basename "$1"
}

first_line() {
  printf '%s' "$1" | head -1
}

repo_state_init() {
  local repo_root="$1"
  local repo_hash
  repo_hash=$(printf '%s' "$repo_root" | md5 2>/dev/null | cut -c1-8 \
    || printf '%s' "$repo_root" | md5sum 2>/dev/null | cut -c1-8 \
    || printf '%s' "$repo_root" | shasum 2>/dev/null | cut -c1-8)
  STATE_DIR="${STATE_DIR_PREFIX}-${repo_hash}"
  mkdir -p "$STATE_DIR"
}

ensure_repo_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null
}

# --- File status detection ---

detect_file_status() {
  local rel_path="$1"
  # Check staged status first
  local name_status
  name_status=$(git diff --cached --name-status -- "$rel_path" 2>/dev/null | head -1)
  case "$name_status" in
    A*) echo "new"; return ;;
    D*) echo "deleted"; return ;;
  esac
  # Check if untracked
  if git ls-files --others --exclude-standard -- "$rel_path" 2>/dev/null | grep -q .; then
    echo "new"; return
  fi
  # Check if deleted from working tree
  if ! [ -e "$rel_path" ] && git ls-files -- "$rel_path" 2>/dev/null | grep -q .; then
    echo "deleted"; return
  fi
  echo "modified"
}

# --- Commit message generation ---

validate_commit_msg() {
  local msg="$1"
  if echo "$msg" | grep -qiE '(^(I |Could |Can |What |Why |Would |Should |Do |Is |Are |Please |It looks|I need|I cannot|I can.t|However|Unfortunately)|(\?[[:space:]]*$))'; then
    return 1
  fi
  return 0
}

build_user_msg() {
  local file_status="$1" rel_path="$2" diff="$3"
  local context=""

  # For deletions, gather context from recent commits
  if [ "$file_status" = "deleted" ]; then
    local recent_context
    recent_context=$(git log --oneline --name-status -5 --diff-filter=ADRC 2>/dev/null \
      | grep -E "^[ADRC]\s" | head -10 | sed 's/^/  /')
    if [ -n "$recent_context" ]; then
      context="
Other changes in this session (use to infer why the file was deleted):
Recent commits:
$recent_context"
    fi
  fi

  case "$file_status" in
    new)     echo "New file created: $rel_path

Diff:
$diff

Generate a commit message for this new file." ;;
    deleted) echo "File deleted: $rel_path

Diff:
$diff
$context
Generate a commit message for this file deletion." ;;
    *)       echo "File edited: $rel_path

Diff:
$diff

Generate a commit message for this edit." ;;
  esac
}

sanitize_commit_message() {
  python3 - <<'PY' "$1"
import re
import sys
import textwrap

message = sys.argv[1]
raw_lines = [line.rstrip() for line in message.splitlines() if line.strip() != '```']
lines = [line for line in raw_lines if line.strip()]

if not lines:
    lines = ["Modify files"]

subject = re.sub(r'^[\-\*\s]+', '', lines[0]).strip()
subject = subject.rstrip('.')
if not subject:
    subject = "Modify files"
if len(subject) > 50:
    subject = subject[:47].rstrip() + "..."

body_inputs = []
for line in lines[1:]:
    cleaned = re.sub(r'^[\-\*\s]+', '', line).strip()
    if cleaned:
        body_inputs.append(cleaned)

if not body_inputs:
    print(subject)
    sys.exit(0)

wrapped_bullets = []
for bullet in body_inputs:
    parts = textwrap.wrap(bullet, width=70, break_long_words=True, break_on_hyphens=False)
    for part in parts:
        wrapped_bullets.append(f"- {part}")

print(subject)
if wrapped_bullets:
    print()
    for bullet in wrapped_bullets:
        print(bullet[:72])
PY
}

generate_commit_msg() {
  local rel_path="$1" file_status="$2" diff="$3"
  local user_msg commit_msg

  user_msg=$(build_user_msg "$file_status" "$rel_path" "$diff")

  if command -v opencode >/dev/null 2>&1; then
    commit_msg=$(run_with_timeout 25 env "${OPENCODE_CHILD_GUARD_VAR}=1" NO_COLOR=1 TERM=dumb \
      opencode run "${SYSTEM_PROMPT}

${user_msg}" \
      --model "$OPENCODE_COMMIT_MODEL" \
      --agent "$OPENCODE_COMMIT_AGENT" 2>/dev/null || true)

    if [ -n "$commit_msg" ]; then
      # Strip ANSI codes and opencode output noise
      commit_msg=$(printf '%s' "$commit_msg" | python3 -c 'import re, sys
text = sys.stdin.read()
text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
lines = [line.rstrip() for line in text.splitlines()]
filtered = []
for line in lines:
    stripped = line.strip()
    if not stripped:
        continue
    if stripped.startswith("> "):
        continue
    filtered.append(stripped)
print("\n".join(filtered))')

      if [ -n "$commit_msg" ] && validate_commit_msg "$commit_msg"; then
        sanitize_commit_message "$commit_msg"
        return 0
      fi
    fi
  fi

  # Fallback: deterministic message
  local safe_label
  safe_label="$(ensure_relative_label "$rel_path")"
  case "$file_status" in
    new)     echo "Add ${safe_label}" ;;
    deleted) echo "Remove ${safe_label}" ;;
    *)       echo "Modify ${safe_label}" ;;
  esac
}

# --- Staging and committing ---

stage_paths_from_changes() {
  local staged_any=0
  while IFS= read -r rel_path; do
    [[ -z "$rel_path" ]] && continue
    git add -- "$rel_path" 2>/dev/null || true
    staged_any=1
  done

  [[ "$staged_any" -eq 0 ]] && return 1
  git diff --cached --quiet 2>/dev/null && return 1
  return 0
}

build_commit_label() {
  python3 - <<'PY'
import os, sys, subprocess

repo = None
try:
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
except Exception:
    pass

paths = []
for line in sys.stdin:
    p = line.strip()
    if not p:
        continue
    if p.startswith("/") and repo:
        p = os.path.relpath(p, repo)
    elif p.startswith("/"):
        p = os.path.basename(p)
    paths.append(p)

if not paths:
    print("reported file changes")
elif len(paths) == 1:
    print(paths[0])
else:
    print(f"{paths[0]} (and {len(paths) - 1} more)")
PY
}

commit_staged() {
  local label="$1"

  # Bail early if nothing staged — this is the key optimization
  # that avoids wasted LLM calls when the file was already committed
  git diff --cached --quiet 2>/dev/null && {
    debug "nothing staged for '$label' — skipping"
    return 0
  }

  local diff_text file_status commit_msg

  diff_text="$(git diff --cached 2>/dev/null | head -100)"
  diff_text="${diff_text:0:4000}"

  local status_line
  status_line="$(git diff --cached --name-status 2>/dev/null | head -1)"
  case "$status_line" in
    A*) file_status="new" ;;
    D*) file_status="deleted" ;;
    *)  file_status="modified" ;;
  esac

  commit_msg="$(generate_commit_msg "$label" "$file_status" "$diff_text")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Would commit: $(first_line "$commit_msg")"
    return 0
  fi

  debug "generating commit message for '$label' (status=$file_status)"
  if git commit -m "$commit_msg" 2>&1; then
    debug "committed: $(first_line "$commit_msg")"
  else
    debug "COMMIT FAILED for $label"
    log "atomic-commit-async: commit failed for $label" >&2
  fi
}

# --- CLI mode: --each ---

run_each_mode() {
  local repo_root
  repo_root="$(ensure_repo_root "$TARGET_DIR")" || { log "Not a git repo"; exit 1; }
  repo_state_init "$repo_root"
  cd "$repo_root" || exit 1

  local all_files
  all_files="$({
    git diff --name-only 2>/dev/null
    git diff --cached --name-only 2>/dev/null
    git ls-files --deleted 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u | grep -v '^$')"

  if [[ -z "$all_files" ]]; then
    log "Nothing to commit — working tree clean."
    exit 0
  fi

  local file_count
  file_count="$(printf '%s\n' "$all_files" | wc -l | tr -d ' ')"
  log "Committing $file_count file(s) individually..."

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    git reset HEAD -- . >/dev/null 2>&1 || true
    git add -- "$file" 2>/dev/null || true
    if git diff --cached --quiet 2>/dev/null; then
      continue
    fi

    commit_staged "$file"
  done <<< "$all_files"

  log "Done."
}

# --- Hook mode ---

run_hook_mode() {
  debug "=== hook invoked ==="

  # Guard against recursive calls from opencode run
  if [[ "${!OPENCODE_CHILD_GUARD_VAR:-}" == "1" ]]; then
    debug "child guard active — skipping"
    exit 0
  fi

  # Skip flag for manual commit workflows
  if [ -f /tmp/skip-opencode-atomic-commit ]; then
    local skip_ts now_ts
    skip_ts=$(cat /tmp/skip-opencode-atomic-commit 2>/dev/null || echo 0)
    now_ts=$(date +%s)
    if [ $(( now_ts - skip_ts )) -lt 300 ]; then
      exit 0
    else
      rm -f /tmp/skip-opencode-atomic-commit
    fi
  fi

  local input_json
  input_json="$(cat)"
  [[ -z "$input_json" ]] && { debug "empty stdin — exiting"; exit 0; }

  local event cwd project_dir repo_root
  event="$(printf '%s' "$input_json" | jq -r '.event // empty')"
  cwd="$(printf '%s' "$input_json" | jq -r '.cwd // empty')"
  project_dir="${OPENCODE_PROJECT_DIR:-${cwd:-}}"

  debug "event=$event cwd=$cwd project_dir=$project_dir"
  debug "payload: $(printf '%s' "$input_json" | head -c 500)"

  [[ -z "$project_dir" ]] && { debug "no project_dir — exiting"; exit 0; }

  # Only handle file.changed and tool.after events
  case "$event" in
    file.changed|tool.after.*) ;;
    *) debug "unsupported event '$event' — exiting"; exit 0 ;;
  esac

  repo_root="$(ensure_repo_root "$project_dir")" || { debug "not a git repo — exiting"; exit 0; }
  repo_state_init "$repo_root"
  cd "$repo_root" || exit 0
  debug "repo_root=$repo_root"

  # Extract paths from the payload
  local changed_paths=""

  if [[ "$event" == "file.changed" ]]; then
    # Preferred: use structured changes array
    changed_paths="$(printf '%s' "$input_json" | python3 -c 'import json, sys
payload = json.load(sys.stdin)
seen = set()
for change in payload.get("changes") or []:
    if not isinstance(change, dict):
        continue
    op = change.get("operation")
    candidates = []
    if op == "rename":
        candidates.extend([change.get("fromPath"), change.get("toPath")])
    else:
        candidates.append(change.get("path"))
    for c in candidates:
        if isinstance(c, str) and c.strip() and c not in seen:
            seen.add(c)
            print(c)
')"

    # Fallback: use files array
    if [[ -z "$changed_paths" ]]; then
      changed_paths="$(printf '%s' "$input_json" | python3 -c 'import json, sys
payload = json.load(sys.stdin)
seen = set()
for f in payload.get("files") or []:
    if isinstance(f, str) and f.strip() and f not in seen:
        seen.add(f)
        print(f)
')"
    fi
  else
    # tool.after.* fallback: extract from tool_args
    local tool_name
    tool_name="$(printf '%s' "$input_json" | jq -r '.tool_name // empty')"

    case "$tool_name" in
      write|edit|multiedit)
        changed_paths="$(printf '%s' "$input_json" | python3 -c 'import json, sys
payload = json.load(sys.stdin)
args = payload.get("tool_args") or {}
for key in ("filePath", "file_path", "path"):
    v = args.get(key)
    if isinstance(v, str) and v.strip():
        print(v)
        break
')"
        ;;
      patch|apply_patch)
        changed_paths="$(printf '%s' "$input_json" | python3 -c 'import json, sys
payload = json.load(sys.stdin)
args = payload.get("tool_args") or {}
patch = args.get("patchText") or args.get("patch") or args.get("diff") or ""
seen = set()
prefixes = ("*** Update File: ", "*** Add File: ", "*** Delete File: ", "*** Move to: ")
for line in str(patch).splitlines():
    for prefix in prefixes:
        if line.startswith(prefix):
            path = line[len(prefix):].strip()
            if path and path not in seen:
                seen.add(path)
                print(path)
            break
')"
        ;;
      *)
        exit 0
        ;;
    esac
  fi

  if [[ -z "$changed_paths" ]]; then
    debug "no changed paths extracted — exiting"
    exit 0
  fi

  debug "changed_paths: $(printf '%s' "$changed_paths" | tr '\n' ', ')"

  # Stage the reported paths and check if there's anything to commit
  if ! stage_paths_from_changes <<< "$changed_paths"; then
    debug "nothing to stage — exiting"
    exit 0
  fi

  # Build a human-readable label from the paths
  local label
  label="$(printf '%s\n' "$changed_paths" | build_commit_label)"

  debug "committing: $label"
  commit_staged "$label"
  debug "=== hook finished ==="
}

# --- Entry point ---

if [[ "$EACH_MODE" -eq 1 ]]; then
  run_each_mode
else
  run_hook_mode
fi
