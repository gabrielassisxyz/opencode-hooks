# Hook configuration examples

These examples are intended for operators adopting the standalone `opencode-hooks` plugin. Copy the sections you need into a real hook config file at either:

- `~/.config/opencode/hook/hooks.md`
- `<project>/.opencode/hook/hooks.md`

Every file must begin with YAML frontmatter.

## Full example covering all supported events

```markdown
---
hooks:
  - event: session.created
    conditions: [isMainSession]
    actions:
      - bash: |
          echo "session started: $OPENCODE_SESSION_ID"

  - event: session.deleted
    conditions: [isMainSession]
    actions:
      - bash: |
          echo "session ended: $OPENCODE_SESSION_ID"

  - event: session.idle
    conditions: [hasCodeChange, isMainSession]
    actions:
      - bash:
          command: "npm run lint --fix"
          timeout: 30000
      - command: simplify-changes

  - event: tool.before.*
    actions:
      - bash: |
          context=$(cat)
          echo "before tool: $(echo \"$context\" | jq -r '.tool_name')"

  - event: tool.before.write
    actions:
      - bash: |
          file=$(cat | jq -r '.tool_args.filePath // .tool_args.file_path // .tool_args.path')
          if echo "$file" | grep -qE '\.(env|pem|key)$'; then
            echo "Cannot modify sensitive files: $file" >&2
            exit 2
          fi

  - event: tool.after.*
    actions:
      - bash: |
          context=$(cat)
          echo "after tool: $(echo \"$context\" | jq -r '.tool_name')"

  - event: tool.after.edit
    actions:
      - bash: |
          file=$(cat | jq -r '.tool_args.filePath // .tool_args.file_path // .tool_args.path')
          echo "edited $file"
---
```

## Notes for operators

- Global and project hook files are merged together.
- Hooks for the same event run in declaration order.
- `tool.before.*` runs before `tool.before.<name>`.
- Only a bash action returning exit code `2` during a `tool.before` hook blocks the tool.
- Bash actions inherit the current process environment in addition to `OPENCODE_*` variables.
- `session.idle` receives a `files` array only for paths tracked through `write`, `edit`, `multiedit`, and `apply_patch`.
- `session.idle` clears tracked files only after hook dispatch succeeds, so failed idle dispatches can be retried.
- `hasCodeChange` only passes when at least one tracked path has a supported code extension.

## Bash stdin reference

### Session hook input

```json
{
  "session_id": "abc123",
  "event": "session.idle",
  "cwd": "/repo/project",
  "files": ["src/index.ts", "src/core/runtime.ts"]
}
```

### Tool hook input

```json
{
  "session_id": "abc123",
  "event": "tool.before.write",
  "cwd": "/repo/project",
  "tool_name": "write",
  "tool_args": {
    "filePath": "src/index.ts"
  }
}
```
