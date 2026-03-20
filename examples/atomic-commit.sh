#!/usr/bin/env bash
set -euo pipefail

# atomic-commit.sh — OpenCode hook for atomic commits.
#
# Usage:
#   Hook mode: receives OpenCode hook JSON on stdin.
#     Intended for tool.after.* hooks, for example:
#       - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
#
#   CLI mode:
#     atomic-commit.sh --each [directory] [--dry-run]
#     Commits each uncommitted file individually.
#
# Notes:
# - In hook mode, only tool.after.* events are handled.
# - Supports write, edit, multiedit, apply_patch, and bash.
# - Uses `opencode run ... --model ... --agent build` for commit messages when available,
#   with a deterministic fallback.

DRY_RUN=0
EACH_MODE=0
TARGET_DIR="."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --each)
      EACH_MODE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      TARGET_DIR="$1"
      shift
      ;;
  esac
done

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
- Output ONLY the commit message, nothing else — no markdown fences, no explanation'

OPENCODE_COMMIT_MODEL="opencode/big-pickle"
OPENCODE_COMMIT_AGENT="build"
OPENCODE_CHILD_GUARD_VAR="OPENCODE_ATOMIC_COMMIT_CHILD"

log() {
  printf '%s\n' "$*"
}

first_line() {
  python3 - <<'PY' "$1"
import sys
text = sys.argv[1]
print(text.splitlines()[0] if text else "")
PY
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
    body_inputs = ["Preserve atomic commit behavior with a formatted message"]

wrapped_bullets = []
for bullet in body_inputs:
    parts = textwrap.wrap(bullet, width=70, break_long_words=True, break_on_hyphens=False)
    if not parts:
        continue
    for part in parts:
        wrapped_bullets.append(f"- {part}")

if not wrapped_bullets:
    wrapped_bullets = ["- Preserve atomic commit behavior with a formatted message"]

print(subject)
print()
for bullet in wrapped_bullets:
    print(bullet[:72])
PY
}

generate_commit_message() {
  local file_status="$1"
  local file_label="$2"
  local diff_text="$3"
  local user_msg

  case "$file_status" in
    new)
      user_msg="New file created: $file_label

Diff:
$diff_text

Generate a commit message for this new file."
      ;;
    deleted)
      user_msg="File deleted: $file_label

Diff:
$diff_text

Generate a commit message for this file deletion."
      ;;
    *)
      user_msg="File edited: $file_label

Diff:
$diff_text

Generate a commit message for this edit."
      ;;
  esac

  if command -v opencode >/dev/null 2>&1; then
    local generated cleaned
    generated="$(env "$OPENCODE_CHILD_GUARD_VAR=1" NO_COLOR=1 TERM=dumb opencode run "${SYSTEM_PROMPT}

${user_msg}" --model "$OPENCODE_COMMIT_MODEL" --agent "$OPENCODE_COMMIT_AGENT" 2>/dev/null || true)"
    if [[ -n "$generated" ]]; then
      cleaned="$(printf '%s' "$generated" | python3 -c 'import re, sys
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
print("\n".join(filtered))')"
      if [[ -n "$cleaned" ]]; then
        sanitize_commit_message "$cleaned"
        return 0
      fi
    fi
  fi

  sanitize_commit_message "Modify ${file_label}

- Preserve atomic commit behavior when AI message generation is unavailable"
}

ensure_repo_root() {
  local repo_root
  repo_root="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 1
  printf '%s\n' "$repo_root"
}

collect_all_changed_files() {
  {
    git diff --name-only 2>/dev/null
    git diff --cached --name-only 2>/dev/null
    git ls-files --deleted 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | python3 -c 'import sys
seen = set()
for raw in sys.stdin:
    path = raw.strip()
    if path and path not in seen:
        seen.add(path)
        print(path)'
}

extract_opencode_file_path() {
  python3 -c 'import json, sys
payload = json.load(sys.stdin)
tool_args = payload.get("tool_args") or {}
for key in ("filePath", "file_path", "path"):
    value = tool_args.get(key)
    if isinstance(value, str) and value.strip():
        print(value)
        break'
}

extract_apply_patch_paths() {
  python3 -c 'import json, sys
payload = json.load(sys.stdin)
tool_args = payload.get("tool_args") or {}
patch = tool_args.get("patchText") or tool_args.get("patch") or ""
seen = set()
prefixes = (
    "*** Update File: ",
    "*** Add File: ",
    "*** Delete File: ",
    "*** Move to: ",
)
for line in str(patch).splitlines():
    for prefix in prefixes:
        if line.startswith(prefix):
            path = line[len(prefix):].strip()
            if path and path not in seen:
                seen.add(path)
                print(path)
            break'
}

stage_paths() {
  local staged_any=0
  while IFS= read -r rel_path; do
    [[ -z "$rel_path" ]] && continue
    git add -- "$rel_path" 2>/dev/null || true
    staged_any=1
  done

  if [[ "$staged_any" -eq 0 ]]; then
    return 1
  fi

  git diff --cached --quiet 2>/dev/null && return 1
  return 0
}

determine_primary_status() {
  local name_status="$1"
  case "$name_status" in
    A*) printf 'new\n' ;;
    D*) printf 'deleted\n' ;;
    *) printf 'modified\n' ;;
  esac
}

commit_staged_changes() {
  local file_label="$1"

  git diff --cached --quiet 2>/dev/null && {
    log "Nothing staged — skipping."
    return 0
  }

  local diff_text
  local status_line
  local file_status
  local commit_msg

  diff_text="$(git diff --cached 2>/dev/null | python3 -c 'import sys
data = sys.stdin.read().splitlines()
print("\n".join(data[:100])[:4000])')"

  status_line="$(git diff --cached --name-status 2>/dev/null | python3 -c 'import sys
for line in sys.stdin:
    line = line.rstrip("\n")
    if line:
        print(line)
        break')"
  file_status="$(determine_primary_status "$status_line")"
  commit_msg="$(generate_commit_message "$file_status" "$file_label" "$diff_text")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] Would commit: $(first_line "$commit_msg")"
    return 0
  fi

  git commit -m "$commit_msg" --no-verify 2>&1
  log "Committed: $(first_line "$commit_msg")"
}

run_each_mode() {
  local repo_root
  repo_root="$(ensure_repo_root "$TARGET_DIR")" || {
    log "Not a git repo"
    exit 1
  }
  cd "$repo_root" || exit 1

  local all_files
  all_files="$(collect_all_changed_files)"
  if [[ -z "$all_files" ]]; then
    log "Nothing to commit — working tree clean."
    exit 0
  fi

  local file_count
  file_count="$(printf '%s\n' "$all_files" | python3 -c 'import sys
print(sum(1 for line in sys.stdin if line.strip()))')"
  log "Committing $file_count file(s) individually..."

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    git reset HEAD -- . >/dev/null 2>&1 || true
    git add -- "$file" 2>/dev/null || true
    git diff --cached --quiet 2>/dev/null && continue
    commit_staged_changes "$file"
  done <<< "$all_files"

  log "Done."
}

run_hook_mode() {
  local input_json event tool_name cwd project_dir repo_root file_path patch_paths label
  if [[ "${!OPENCODE_CHILD_GUARD_VAR:-}" == "1" ]]; then
    exit 0
  fi

  input_json="$(cat)"
  [[ -z "$input_json" ]] && exit 0

  event="$(printf '%s' "$input_json" | jq -r '.event // empty')"
  tool_name="$(printf '%s' "$input_json" | jq -r '.tool_name // empty')"
  cwd="$(printf '%s' "$input_json" | jq -r '.cwd // empty')"
  project_dir="${OPENCODE_PROJECT_DIR:-${cwd:-}}"

  [[ -z "$project_dir" ]] && exit 0

  case "$event" in
    tool.after.*) ;;
    *) exit 0 ;;
  esac

  repo_root="$(ensure_repo_root "$project_dir")" || exit 0
  cd "$repo_root" || exit 0

  if [[ "$tool_name" == "bash" ]]; then
    git add -A 2>/dev/null || true
    commit_staged_changes "bash changes"
    exit 0
  fi

  if [[ "$tool_name" == "apply_patch" ]]; then
    patch_paths="$(printf '%s' "$input_json" | extract_apply_patch_paths)"
    if [[ -z "$patch_paths" ]]; then
      exit 0
    fi

    if ! stage_paths <<< "$patch_paths"; then
      exit 0
    fi

    label="$(printf '%s\n' "$patch_paths" | python3 -c 'import sys
paths = [line.strip() for line in sys.stdin if line.strip()]
if not paths:
    print("patched files")
elif len(paths) == 1:
    print(paths[0])
else:
    print(f"{paths[0]} (and {len(paths) - 1} more)")')"
    commit_staged_changes "$label"
    exit 0
  fi

  case "$tool_name" in
    write|edit|multiedit)
      file_path="$(printf '%s' "$input_json" | extract_opencode_file_path)"
      [[ -z "$file_path" ]] && exit 0
      if [[ "$file_path" != /* ]]; then
        file_path="$project_dir/$file_path"
      fi
      file_path="$(python3 - <<'PY' "$file_path"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
      label="$(python3 - <<'PY' "$file_path" "$repo_root"
import os, sys
print(os.path.relpath(sys.argv[1], sys.argv[2]))
PY
)"
      git add -- "$label" 2>/dev/null || true
      git diff --cached --quiet 2>/dev/null && exit 0
      commit_staged_changes "$label"
      ;;
    *)
      exit 0
      ;;
  esac
}

if [[ "$EACH_MODE" -eq 1 ]]; then
  run_each_mode
else
  run_hook_mode
fi
