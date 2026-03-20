#!/bin/bash
set -euo pipefail

# Rewrite bad "Modify ..." commit messages on the current branch.
# Uses claude -p (Haiku) to generate proper semantic messages from each commit's diff.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$SCRIPT_DIR")
cd "$REPO_DIR"

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

# Collect all bad commit hashes (oldest first for rebase order)
BAD_COMMITS=()
while IFS= read -r line; do
  hash="${line%% *}"
  BAD_COMMITS+=("$hash")
done < <(git log --format="%H %s" main..HEAD | grep " Modify " | tac)

echo "Found ${#BAD_COMMITS[@]} commits to rewrite."
echo ""

# Pre-generate all new messages BEFORE rewriting history
declare -A NEW_MESSAGES
for hash in "${BAD_COMMITS[@]}"; do
  old_msg=$(git log -1 --format="%s" "$hash")
  diff=$(git diff-tree -p "$hash" 2>/dev/null | head -100)
  diff="${diff:0:4000}"
  files=$(git diff-tree --no-commit-id --name-only -r "$hash" 2>/dev/null)

  # Determine status
  status_info=$(git diff-tree --no-commit-id --name-status -r "$hash" 2>/dev/null | head -1)
  case "$status_info" in
    A*) file_status="new" ;;
    D*) file_status="deleted" ;;
    *)  file_status="modified" ;;
  esac

  # Build file label
  file_count=$(echo "$files" | wc -l | tr -d ' ')
  file_label=$(echo "$files" | head -1)
  [ "$file_count" -gt 1 ] && file_label="$file_label (and $((file_count - 1)) more)"

  case "$file_status" in
    new)     user_msg="New file created: $file_label

Diff:
$diff

Generate a commit message for this new file." ;;
    deleted) user_msg="File deleted: $file_label

Diff:
$diff

Generate a commit message for this file deletion." ;;
    *)       user_msg="File edited: $file_label

Diff:
$diff

Generate a commit message for this edit." ;;
  esac

  new_msg=$(claude -p "$user_msg" \
    --system-prompt "$SYSTEM_PROMPT" \
    --model haiku \
    --effort low \
    --no-session-persistence \
    --output-format text < /dev/null 2>/dev/null || true)

  # Clean up markdown fences
  new_msg=$(echo "$new_msg" | sed '/^```/d')

  # Validate subject line
  first_line=$(echo "$new_msg" | head -1)
  if [ -z "$first_line" ]; then
    # Fallback if claude fails
    case "$file_status" in
      new)     new_msg="Add $file_label" ;;
      deleted) new_msg="Remove $file_label" ;;
      *)       new_msg="Update $file_label" ;;
    esac
    first_line=$(echo "$new_msg" | head -1)
  fi
  if [ ${#first_line} -gt 50 ]; then
    first_line="${first_line:0:47}..."
    rest=$(echo "$new_msg" | tail -n +2)
    new_msg=$(printf '%s\n%s' "$first_line" "$rest")
  fi

  NEW_MESSAGES["$hash"]="$new_msg"
  echo "[$hash] $(echo "$old_msg" | cut -c1-60)"
  echo "      → $(echo "$new_msg" | head -1)"
  echo ""
done

echo "---"
echo "All messages generated. Starting rewrite..."
echo ""

# Write messages to temp files for the filter to read
MSGDIR=$(mktemp -d)
for hash in "${BAD_COMMITS[@]}"; do
  echo "${NEW_MESSAGES[$hash]}" > "$MSGDIR/$hash"
done

# Use git filter-branch to rewrite only the bad commits
BASE_COMMIT=$(git merge-base main HEAD)
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --msg-filter "
  COMMIT_HASH=\$(git log -1 --format='%H' 2>/dev/null || echo '')
  if [ -f \"$MSGDIR/\$COMMIT_HASH\" ]; then
    cat \"$MSGDIR/\$COMMIT_HASH\"
  else
    cat
  fi
" "${BASE_COMMIT}..HEAD"

# Cleanup
rm -rf "$MSGDIR"

echo ""
echo "Done! Rewritten ${#BAD_COMMITS[@]} commits."
echo ""
echo "New log:"
git log --oneline main..HEAD
