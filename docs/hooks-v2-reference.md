# Hooks v2 reference

Use `hooks.yaml` to run automation on OpenCode session and tool lifecycle events.

If you only need one rule, start with `file.changed`. It is the cleanest hook for file-oriented workflows like linting, formatting, test selection, indexing, and atomic commits.

## Supported config files

The runtime discovers hooks in this order:

1. `~/.config/opencode/hook/hooks.yaml`
2. `%APPDATA%/opencode/hook/hooks.yaml` on Windows, but only when the preferred global file does not exist
3. `<project>/.opencode/hook/hooks.yaml`

Global hooks load first. Project hooks load second.

## Top-level shape

```yaml
hooks:
  - id: <optional-hook-id>
    event: <hook-event>
    action: <stop>
    scope: <all|main|child>
    runIn: <current|main>
    async: <boolean>
    conditions:
      - matchesCodeFiles
      - matchesAnyPath: src/**/*.ts
      - matchesAllPaths:
          - package.json
          - apps/*/package.json
    actions:
      - command: <string>
```

Rules:

- `hooks` is required
- `hooks` must be an array
- each item in `hooks` must be an object
- normal hooks need a non-empty `actions` array
- each action must define exactly one of `command`, `tool`, or `bash`
- `action`, when present, must be `stop` and is only valid on `tool.before.*` and `tool.before.<name>` hooks
- `id` is optional, but you need it if a later file should override or disable the hook
- override entries also live inside `hooks`

## Hook fields

### `id`

Optional for normal hooks.

Use `id` when you want a later config file to replace or disable a hook from an earlier file.

Rules:

- must be a non-empty string when present
- must be unique within the same `hooks.yaml` file
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

`scope` controls which session can trigger the hook.

| Value | Meaning |
|---|---|
| `all` | Main and child sessions can trigger the hook |
| `main` | Only the root session can trigger the hook |
| `child` | Only child sessions can trigger the hook |

### `action`

Optional.

The only supported value is `stop`.

Use `action: stop` on a blocking pre-tool hook when you want the runtime to make a best-effort attempt to abort the active session after the hook blocks execution.

Rules:

- only supported on `tool.before.*` and `tool.before.<name>`
- only meaningful when a `bash` action exits with code `2`
- ignored for non-blocking hooks because only pre-tool bash hooks can block

### `runIn`

Optional. Default: `current`.

`runIn` controls where `command` and `tool` actions execute.

| Value | Meaning |
|---|---|
| `current` | Run the action in the session that triggered the hook |
| `main` | Run the action in the root session for that session tree |

Notes:

- `runIn` affects `command` and `tool` actions only
- `bash` actions run in the plugin runtime process, not in another OpenCode session

### `async`

Optional. Default: synchronous.

When `async: true`, the hook returns immediately and its actions run in the background.

Rules:

- must be a boolean when present
- cannot be `true` on `tool.before.*` or `tool.before.<name>` hooks
- cannot be `true` on `session.idle`
- async hooks must use only `bash` actions
- actions inside one async hook still run sequentially
- async work is serialized per event and source session, so rapid-fire triggers queue up instead of overlapping
- async failures are logged, not thrown
- async execution is best-effort, so work can be lost if the host process exits early

### `conditions`

Optional.

Supported values:

- `matchesCodeFiles`
- `matchesAnyPath: <string|string[]>`
- `matchesAllPaths: <string|string[]>`

All configured conditions must pass.

Rules:

- `matchesCodeFiles` checks whether at least one tracked changed file has a supported code extension
- `matchesAnyPath` passes when at least one final changed file path matches at least one supplied glob pattern
- `matchesAllPaths` passes when every final changed file path matches at least one supplied glob pattern
- `matchesAnyPath` and `matchesAllPaths` only work on `file.changed` and `session.idle`
- path conditions accept either a non-empty string or a non-empty string array
- empty strings, empty arrays, non-string entries, and unknown condition keys are rejected
- path conditions fail when there are no changed files to evaluate

Example:

```yaml
hooks:
  - id: lint-src-on-change
    event: file.changed
    conditions:
      - matchesAnyPath: src/**/*.ts
    actions:
      - bash: "npm run lint -- --fix"

  - id: verify-package-edits-when-idle
    event: session.idle
    scope: main
    conditions:
      - matchesAllPaths:
          - package.json
          - apps/*/package.json
    actions:
      - bash: "npm test"
```

Invalid example:

```yaml
hooks:
  - event: tool.after.write
    conditions:
      - matchesAnyPath: src/**/*.ts
    actions:
      - bash: "echo invalid"
```

The example above is rejected because path conditions are only supported on `file.changed` and `session.idle`.

### `actions`

Required for normal hooks and replacement overrides.

Rules:

- must be an array
- must be non-empty
- each action must define exactly one of `command`, `tool`, or `bash`

### `override`

Optional. Only use this on override entries.

`override` must be a non-empty string containing the target hook id.

Supported modes:

- replacement override: `override: <target-id>` plus a full replacement hook
- disable override: `override: <target-id>` plus `disable: true`

Replacement overrides must still define a valid hook, including `event` and a non-empty `actions` array.

### `disable`

Optional. Only meaningful together with `override`.

- `disable: true` removes the targeted earlier hook
- omitted or `false` means the override entry is treated as a replacement hook

## Validation summary

The loader rejects invalid entries and keeps the last valid config state active.

Common validation rules:

- invalid or unreadable YAML is rejected
- missing `hooks` is rejected
- non-array `hooks` is rejected
- unsupported `event`, `scope`, `runIn`, `action`, or condition values are rejected
- invalid action shapes are rejected
- duplicate `id` values inside one file are rejected
- an override targeting an unknown id is rejected

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

- runs an OpenCode command
- runs in the current session by default
- uses the root session when `runIn: main`
- failures are logged and later actions still run

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
- failures are logged and later actions still run

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

Behavior:

- runs directly, without another LLM step
- receives JSON context on stdin
- inherits the current process environment plus OpenCode-specific variables
- uses a default timeout of `60000` milliseconds when `timeout` is omitted

## Event reference

## `session.created`

Fires when OpenCode creates a session.

Good uses:

- bootstrap commands
- logging session startup
- root-session setup with `scope: main`

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

Good uses:

- cleanup notifications
- end-of-session logging

## `session.idle`

Fires when a session becomes idle.

Behavior:

- receives the accumulated tracked file changes for the current session
- clears tracked changes only after successful dispatch
- preserves tracked changes if dispatch fails

Good uses:

- batch checks after a burst of edits
- deferred follow-up work

Do not use `async: true` here. Idle dispatch needs to finish before tracked changes are consumed.

## `file.changed`

Fires after a supported mutation tool reports file changes.

This is the recommended public API for file-oriented automation.

Supported mutation tools:

- `write`
- `edit`
- `multiedit`
- `patch`
- `apply_patch`

Good uses:

- linting and formatting
- test selection
- indexing
- atomic commit workflows

Example:

```yaml
hooks:
  - id: lint-on-change
    event: file.changed
    conditions:
      - matchesCodeFiles
      - matchesAnyPath: src/**/*.ts
    actions:
      - bash:
          command: "npm run lint -- --fix"
          timeout: 30000
```

## `tool.before.*`

Fires before every tool execution.

Good uses:

- policy checks
- auditing
- blocking invalid operations with a bash exit code of `2`

## `tool.before.<name>`

Fires before one specific tool.

Use this when you need a targeted policy check.

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

This is an advanced hook. Prefer `file.changed` when your workflow depends on changed files.

Good uses:

- observability
- non-file tool auditing

## `tool.after.<name>`

Fires after one specific tool.

This is also advanced. Use it for tool-specific post-processing that does not map cleanly to `file.changed`.

## Hook ordering

For a tool named `write`, hooks run in this order:

1. `tool.before.*`
2. `tool.before.write`
3. tool executes
4. `file.changed`, if tracked changes were detected
5. `tool.after.*`
6. `tool.after.write`

## Override resolution

Overrides are resolved while config files are loaded in discovery order.

What that means in practice:

- earlier files load first
- overrides in a later file can target hooks that were already loaded
- the runtime resolves overrides before it appends normal hooks from the current file
- a replacement override swaps the earlier hook in place
- a disable override removes the earlier hook entirely
- targeting an unknown id produces an `override_target_not_found` validation error
- same-file overrides do not work
- project hooks can override global hooks
- global hooks cannot override project hooks

Replacement example:

Global file:

```yaml
hooks:
  - id: format-on-change
    event: file.changed
    conditions: [matchesCodeFiles]
    actions:
      - bash: "npm run lint -- --fix"
```

Project file:

```yaml
hooks:
  - override: format-on-change
    event: file.changed
    scope: main
    conditions: [matchesCodeFiles]
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

## Bash payload reference

Every `bash` action receives JSON on stdin.

Common fields:

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

### `file.changed` payload example

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

### Tool payload example

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

## Bash environment

`bash` actions inherit the current process environment and also receive:

- `OPENCODE_PROJECT_DIR`
- `OPENCODE_WORKTREE_DIR`
- `OPENCODE_SESSION_ID`
- `OPENCODE_GIT_COMMON_DIR` when available

## Blocking semantics

Only `bash` actions on `tool.before.*` and `tool.before.<name>` can block execution.

| Result | Meaning |
|---|---|
| exit code `0` | success |
| exit code `2` | blocking failure for pre-tool bash hooks |
| any other non-zero exit code | logged, but non-blocking |
| timeout | logged, but non-blocking |

If a blocking pre-tool hook also sets `action: stop`, the runtime makes a best-effort attempt to abort the active session.

## Recommended patterns

### Prefer `file.changed` for file-oriented automation

```yaml
hooks:
  - id: atomic-commit-on-change
    event: file.changed
    scope: main
    conditions:
      - matchesCodeFiles
      - matchesAnyPath:
          - src/**/*.{ts,tsx,js,jsx}
          - package.json
    actions:
      - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
```

### Use `async: true` for best-effort background bash work

```yaml
hooks:
  - id: async-atomic-commit
    event: file.changed
    async: true
    scope: main
    conditions: [matchesCodeFiles]
    actions:
      - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
```

The agent does not wait for the commit to finish. Rapid-fire edits queue up and run one at a time for the same event and source session.

### Route child activity back to the main session

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

### Use `tool.after.*` only when `file.changed` is the wrong abstraction

```yaml
hooks:
  - id: audit-tool-usage
    event: tool.after.*
    actions:
      - bash: |
          context=$(cat)
          echo "advanced after hook for $(echo "$context" | jq -r '.tool_name')"
```

Use low-level tool hooks when you really need raw tool activity. Otherwise, stick with `file.changed`.
