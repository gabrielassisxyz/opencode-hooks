# Hooks v2 reference

This is the operator reference for the current `hooks.yaml` schema implemented on this branch.

## Supported config files

The runtime discovers these files:

- `~/.config/opencode/hook/hooks.yaml`
- `%APPDATA%/opencode/hook/hooks.yaml` on Windows when the preferred global file does not exist
- `<project>/.opencode/hook/hooks.yaml`

Global hooks load first. Project hooks load second. Matching hooks are combined.

## Top-level shape

```yaml
hooks:
  - id: <optional-hook-id>
    event: <hook-event>
    scope: <all|main|child>
    runIn: <current|main>
    async: <boolean>
    conditions:
      - hasCodeChange
    actions:
      - command: <string>
```

Rules:

- `hooks` is required
- `hooks` must be an array
- each hook entry must be an object
- `id` is optional, but required when another file needs to override or disable the hook
- `actions` is required and must be non-empty for normal hooks
- each action must define exactly one of `command`, `tool`, or `bash`
- override entries also live inside `hooks`, target an existing hook `id`, and either replace that hook or disable it

## Hook fields

### `id`

Optional for normal hook definitions. Must be a non-empty string when present.

Use `id` when you want a later config file to override or disable a hook from an earlier file.

Rules:

- ids must be unique within the same `hooks.yaml` file
- override targets are matched by `id`
- hooks without an `id` cannot be targeted by overrides

### `event`

Required for normal hooks and replacement overrides.

Supported values:

- `session.created`
- `session.deleted`
- `session.idle`
- `file.changed`
- `tool.before.*`
- `tool.before.<name>`
- `tool.after.*`
- `tool.after.<name>`

### `scope`

Optional. Default: `all`.

Controls which session can trigger the hook.

- `all`: main and child sessions can trigger the hook
- `main`: only the root session can trigger the hook
- `child`: only child sessions can trigger the hook

### `runIn`

Optional. Default: `current`.

Controls where command and tool actions run.

- `current`: run actions in the session that triggered the hook
- `main`: run actions in the root session for that session tree

Notes:

- `runIn` affects command and tool actions
- bash actions run directly in the runtime process context and do not attach to another OpenCode session

### `async`

Optional. Default: not set (synchronous).

When `true`, the hook's actions execute in the background without blocking the tool pipeline. The hook returns immediately and actions run asynchronously.

Rules:

- must be a boolean when present
- cannot be `true` on `tool.before.*` or `tool.before.<name>` events because blocking requires synchronous execution
- cannot be `true` on `session.idle` events because idle dispatch must complete before tracked changes are consumed
- async hooks must use only `bash` actions; `command` and `tool` actions have no timeout and can stall the async queue indefinitely
- async actions for the same event and source session are serialized — rapid-fire tool calls produce a queue, not concurrent overlapping executions; serialization is per source session, not per resolved target (e.g. `runIn: main` hooks from different child sessions run independently)
- multiple actions within one async hook still execute sequentially (e.g. `git add` before `git commit`)
- errors from async hooks are logged but never thrown — they cannot crash the host process
- async execution is best-effort: background work is not guaranteed to complete if the host process exits before the queue drains

### `conditions`

Optional.

Supported values:

- `hasCodeChange`

All configured conditions must pass.

### `actions`

Required for normal hooks and replacement overrides. Non-empty array.

Supported action shapes are documented below.

### `override`

Optional. Use this only on override entries inside `hooks`.

`override` must be a non-empty string containing the target hook id.

Two override modes are supported:

- replacement override: set `override: <target-id>` and provide a full replacement hook definition
- disable override: set `override: <target-id>` and `disable: true`

Replacement overrides must still define a valid hook, including `event` and a non-empty `actions` array.

### `disable`

Optional. Only meaningful together with `override`.

- `disable: true` removes the targeted earlier hook
- omitted or `false` means the override entry is treated as a replacement hook

## Actions

### `command`

String form:

```yaml
actions:
  - command: simplify-changes
```

Object form:

```yaml
actions:
  - command:
      name: review-pr
      args: "main feature"
```

Behavior:

- executes an OpenCode command
- runs in the current session by default
- uses the root session when `runIn: main`
- failures are logged and do not block later actions

### `tool`

```yaml
actions:
  - tool:
      name: bash
      args:
        command: "echo done"
```

Behavior:

- prompts the target session to use the named tool with the provided args
- runs in the current session by default
- uses the root session when `runIn: main`
- failures are logged and do not block later actions

### `bash`

String form:

```yaml
actions:
  - bash: "npm run lint"
```

Object form:

```yaml
actions:
  - bash:
      command: "npm run lint -- --fix"
      timeout: 30000
```

Defaults:

- `timeout` is optional
- if omitted, bash timeout defaults to `60000` milliseconds

Behavior:

- runs without another LLM step
- stdin receives JSON context
- environment includes OpenCode-specific variables

## Event reference

## `session.created`

Fires when OpenCode creates a session.

Recommended use:

- welcome or bootstrap commands
- root-session review flows with `scope: main`

Example:

```yaml
hooks:
  - id: main-session-started
    event: session.created
    scope: main
    actions:
      - bash: 'echo "main session started: $OPENCODE_SESSION_ID"'
```

## `session.deleted`

Fires when OpenCode deletes a session.

Recommended use:

- cleanup notifications
- end-of-session logging

## `session.idle`

Fires when a session becomes idle.

Behavior on this branch:

- receives accumulated tracked file changes for the current session
- clears tracked changes only after successful dispatch
- preserves tracked changes when dispatch fails

Recommended use:

- batch checks after a burst of edits
- non-blocking follow-up actions

## `file.changed`

Fires after a supported mutation tool reports file changes.

This is the preferred public API for file-oriented automation.

Supported mutation tools:

- `write`
- `edit`
- `multiedit`
- `patch`
- `apply_patch`

Recommended use:

- linting and formatting
- test selection
- indexing
- atomic commit workflows

Example:

```yaml
hooks:
  - id: lint-on-change
    event: file.changed
    conditions: [hasCodeChange]
    actions:
      - bash:
          command: "npm run lint -- --fix"
          timeout: 30000
```

## `tool.before.*`

Fires before every tool execution.

Recommended use:

- policy checks
- logging
- blocking invalid operations with a bash exit code of `2`

## `tool.before.<name>`

Fires before one specific tool.

Example:

```yaml
hooks:
  - id: block-sensitive-writes
    event: tool.before.write
    actions:
      - bash: |
          file=$(cat | jq -r '.tool_args.filePath // .tool_args.file_path // .tool_args.path')
          if echo "$file" | grep -qE '\.(env|pem|key)$'; then
            echo "Cannot modify sensitive files: $file" >&2
            exit 2
          fi
```

## `tool.after.*`

Fires after every tool execution.

This is an advanced hook. Prefer `file.changed` for file-oriented workflows.

Recommended use:

- observability
- non-file tool auditing

## `tool.after.<name>`

Fires after one specific tool.

This is also advanced. Use it when you need tool-specific post-processing that does not map cleanly to `file.changed`.

## Hook ordering

For a tool named `write`, the runtime order is:

1. `tool.before.*`
2. `tool.before.write`
3. tool executes
4. `file.changed` if tracked changes were detected
5. `tool.after.*`
6. `tool.after.write`

## Override resolution rules

Overrides are resolved while files are loaded in discovery order.

Current load order:

1. global hooks file
2. project hooks file

Resolution behavior implemented on this branch:

- hooks from earlier files are loaded first
- override entries in the current file can only target hooks that were already loaded from earlier files
- the runtime resolves overrides before it appends normal hooks from the current file
- a replacement override swaps the earlier hook in place
- a disable override removes the earlier hook entirely
- targeting an unknown id produces an `override_target_not_found` validation error
- same-file overrides do not work because hooks declared later in the same file have not been loaded yet
- project hooks can override global hooks, but global hooks cannot override project hooks

Replacement example:

Global file:

```yaml
hooks:
  - id: format-on-change
    event: file.changed
    conditions: [hasCodeChange]
    actions:
      - bash: "npm run lint -- --fix"
```

Project file:

```yaml
hooks:
  - override: format-on-change
    event: file.changed
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash:
          command: "pnpm lint --fix"
          timeout: 30000
```

Disable example:

```yaml
hooks:
  - override: format-on-change
    disable: true
```

## Payload reference

## Common bash payload fields

Every bash action receives JSON on stdin with these common fields:

```json
{
  "session_id": "abc123",
  "event": "session.idle",
  "cwd": "/path/to/project"
}
```

Possible additional fields:

- `files`
- `changes`
- `tool_name`
- `tool_args`

## `file.changed` payload

```json
{
  "session_id": "abc123",
  "event": "file.changed",
  "cwd": "/path/to/project",
  "files": ["src/index.ts", "src/renamed.ts"],
  "changes": [
    { "operation": "modify", "path": "src/index.ts" },
    { "operation": "rename", "fromPath": "src/old.ts", "toPath": "src/renamed.ts" }
  ],
  "tool_name": "apply_patch",
  "tool_args": {
    "patchText": "*** Begin Patch\\n...\\n*** End Patch"
  }
}
```

Change operations currently emitted:

- `create`
- `modify`
- `delete`
- `rename`

## Tool payload example

```json
{
  "session_id": "abc123",
  "event": "tool.before.write",
  "cwd": "/path/to/project",
  "tool_name": "write",
  "tool_args": {
    "filePath": "src/index.ts"
  }
}
```

## Environment reference for bash actions

Environment additions include:

- `OPENCODE_PROJECT_DIR`
- `OPENCODE_WORKTREE_DIR`
- `OPENCODE_SESSION_ID`
- `OPENCODE_GIT_COMMON_DIR` when available

The current process environment is otherwise inherited.

## Blocking semantics

Only `tool.before.*` and `tool.before.<name>` bash hooks can block.

- exit code `0`: success
- exit code `2`: blocking failure for `tool.before` bash hooks
- any other non-zero exit code: logged, but non-blocking
- timeout: logged, but non-blocking

## Recommended usage patterns

### Preferred: file-oriented automation

```yaml
hooks:
  - id: atomic-commit-on-change
    event: file.changed
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
```

### Non-blocking async automation

```yaml
hooks:
  - id: async-atomic-commit
    event: file.changed
    async: true
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
```

The agent does not wait for the commit to finish. Rapid-fire edits are serialized — each commit runs after the previous one completes.

### Route child activity back to main

```yaml
hooks:
  - id: review-pr-on-change
    event: file.changed
    scope: all
    runIn: main
    actions:
      - command:
          name: review-pr
          args: "main feature"
```

### Advanced observability hook

```yaml
hooks:
  - id: audit-tool-usage
    event: tool.after.*
    actions:
      - bash: |
          context=$(cat)
          echo "advanced after hook for $(echo "$context" | jq -r '.tool_name')"
```

Use low-level tool hooks when they are truly the right abstraction. Otherwise prefer `file.changed`.
