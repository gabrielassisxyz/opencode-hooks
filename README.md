# opencode-hooks

Standalone OpenCode plugin that loads hook definitions from `hooks.yaml` files and runs command, tool, or bash actions on session and tool lifecycle events.

## Installation

### Install from npm

Add the package to the OpenCode plugin list in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-hooks"]
}
```

Then install the package in the environment where OpenCode resolves plugins.

### Install from local files

You can also place the plugin directory directly in a standard plugin discovery location:

- Project-local: `.opencode/plugin/opencode-hooks/`
- Global: `~/.config/opencode/plugin/opencode-hooks/`

The plugin entrypoint is `src/index.ts`, which exports the OpenCode `Plugin` implementation via `src/adapter/opencode.ts` and wires the runtime created by `createHooksRuntime(...)`.

## Recommended documentation path

Read these in order:

1. [`docs/hooks-v2-reference.md`](docs/hooks-v2-reference.md) for the current public config shape
2. This branch loads `hooks.yaml`, not `hooks.md`, so use the reference above for migration-related behavior too
3. [`examples/hooks.yaml`](examples/hooks.yaml) for copy-pasteable patterns
4. [`docs/comparison-with-claude-code-hooks.md`](docs/comparison-with-claude-code-hooks.md) for how this compares to Claude Code's hook system

## Current config locations

Hooks are merged from global and project locations.

| Platform | Global config | Project config |
|---|---|---|
| macOS / Linux | `~/.config/opencode/hook/hooks.yaml` | `<project>/.opencode/hook/hooks.yaml` |
| Windows | `~/.config/opencode/hook/hooks.yaml` preferred, otherwise `%APPDATA%/opencode/hook/hooks.yaml` | `<project>/.opencode/hook/hooks.yaml` |

Important migration note: this branch loads `hooks.yaml`, not `hooks.md`.

## Recommended operator defaults

Unless you need something more specific:

- prefer `file.changed` for file-oriented automation
- leave `scope` unset unless you need `main` or `child`
- leave `runIn` unset unless you need actions to execute in the root session
- treat `tool.after.*` and `tool.after.<name>` as advanced hooks for observability or non-file workflows

Explicit defaults in the current runtime:

- `scope` defaults to `all`
- `runIn` defaults to `current`
- `conditions` are optional
- bash `timeout` defaults to `60000` milliseconds

## Minimal `hooks.yaml`

Create one of:

- `~/.config/opencode/hook/hooks.yaml`
- `<project>/.opencode/hook/hooks.yaml`

```yaml
hooks:
  - event: file.changed
    conditions: [hasCodeChange]
    actions:
      - bash: "npm test"
```

## Schema overview

```yaml
hooks:
  - event: <hook-event>
    scope: <all|main|child>   # optional, defaults to all
    runIn: <current|main>     # optional, defaults to current
    async: <boolean>          # optional, fire-and-forget execution
    conditions:               # optional
      - hasCodeChange
    actions:                  # required, non-empty
      - command: <string>
      - command:
          name: <string>
          args: <string>
      - tool:
          name: <string>
          args: <object>
      - bash: <string>
      - bash:
          command: <string>
          timeout: <positive integer milliseconds>
```

Validation rules enforced by the runtime:

- `hooks` must exist and be an array
- each hook must be an object with a supported `event`
- `scope`, if present, must be `all`, `main`, or `child`
- `runIn`, if present, must be `current` or `main`
- `async`, if present, must be a boolean; cannot be `true` on `tool.before` or `session.idle` events; async hooks must use only `bash` actions
- `conditions`, if present, must be an array of supported condition names
- `actions` must be a non-empty array
- each action must define exactly one of `command`, `tool`, or `bash`

## Supported events

### Session events

| Event | When it fires |
|---|---|
| `session.created` | When OpenCode creates a session |
| `session.deleted` | When OpenCode deletes a session |
| `session.idle` | When a session becomes idle |
| `file.changed` | After a supported mutation tool reports file changes |

### Tool events

| Event | When it fires |
|---|---|
| `tool.before.*` | Before every tool execution |
| `tool.before.<name>` | Before a specific tool, such as `tool.before.write` |
| `tool.after.*` | Advanced: after every tool execution |
| `tool.after.<name>` | Advanced: after a specific tool, such as `tool.after.edit` |

Tool hook order for a tool named `write`:

1. `tool.before.*`
2. `tool.before.write`
3. tool executes
4. `file.changed` if the tool changed tracked files
5. `tool.after.*`
6. `tool.after.write`

## Public API versus advanced hooks

### Preferred public API: `file.changed`

Use `file.changed` when your automation depends on changed files.

Why it is preferred:

- it only fires for supported mutation tools: `write`, `edit`, `multiedit`, `patch`, and `apply_patch`
- it includes `files` and structured `changes` metadata
- it avoids catch-all after-hook ambiguity
- it is the recommended path for linting, formatting, indexing, and atomic commit workflows

### Advanced escape hatches: `tool.after.*` and `tool.after.<name>`

Keep using low-level tool hooks only when you need:

- observability for every tool call, including non-file tools
- tool-specific post-processing unrelated to changed files
- compatibility with workflows that truly depend on raw tool arguments instead of normalized file changes

## Conditions

All configured conditions must pass for a hook to run.

| Condition | Meaning |
|---|---|
| `hasCodeChange` | Run only when tracked modified files include at least one supported code extension |

`hasCodeChange` is extension-based on this branch. Extensionless files such as `Dockerfile` do not currently count as code changes.

## Actions

### Command action

Runs an OpenCode command in the same session, unless `runIn: main` redirects it to the root session.

```yaml
actions:
  - command: simplify-changes
  - command:
      name: review-pr
      args: "main feature"
```

### Tool action

Prompts the session to use a tool with specific arguments.

```yaml
actions:
  - tool:
      name: bash
      args:
        command: "echo done"
```

### Bash action

Runs a bash command directly without another LLM step.

```yaml
actions:
  - bash: "npm run lint"
  - bash:
      command: "$OPENCODE_PROJECT_DIR/.opencode/hooks/init.sh"
      timeout: 30000
```

If `timeout` is omitted, bash actions use the runtime default of `60000` milliseconds.

`OPENCODE_PROJECT_DIR` remains the action cwd / project directory that triggered the hook. When the directory is inside a git worktree, the runtime also exposes `OPENCODE_WORKTREE_DIR` separately so repo-aware scripts can opt into the worktree root without changing local hook semantics.

## Bash payloads

Every bash action receives:

- inherited `process.env`
- `OPENCODE_PROJECT_DIR` for the action cwd / project directory
- `OPENCODE_WORKTREE_DIR` for the git worktree root when available
- `OPENCODE_SESSION_ID`
- `OPENCODE_GIT_COMMON_DIR` when available
- JSON over stdin

Example `file.changed` payload:

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

## Blocking behavior

Only `tool.before.*` and `tool.before.<name>` hooks can block execution.

- a bash action that exits with `2` blocks the tool
- `tool.after.*`, `tool.after.<name>`, `file.changed`, and session hooks do not block execution
- non-blocking failures are logged and later actions continue

## Execution behavior on this branch

- hooks for the same event run in declaration order
- global hooks load before project hooks
- the runtime reloads discovered `hooks.yaml` files at each hook entrypoint
- invalid reloads are rejected and the last known good config stays active
- `session.idle` clears tracked changes only after successful dispatch
- if idle dispatch fails, tracked changes are preserved for retry
- reentrant `file.changed` and `tool.after.*` dispatches are queued and replayed after the active dispatch finishes
- `async: true` hooks return immediately without blocking the tool pipeline; their actions run in the background as best-effort work
- async actions for the same event and source session are serialized to prevent overlapping executions; note that serialization is per source session, not per target — `runIn: main` hooks from different child sessions are not serialized against each other

## Copy-paste examples

See [`examples/hooks.yaml`](examples/hooks.yaml) for:

- main-session only examples
- child-to-main `runIn: main` routing
- recommended `file.changed` automation
- advanced `tool.after.*` observability
- conservative atomic commit wiring

## Known limitations

- only `hooks.yaml` is discovered; `hooks.md` is a migration target, not a supported input
- file tracking is limited to supported OpenCode mutation tools, not arbitrary filesystem changes
- `hasCodeChange` is extension-based and ignores extensionless code-like files
- tool hooks depend on actual emitted OpenCode tool names
- Windows discovery is supported, but bash actions still require a working shell runtime
- `async: true` is not allowed on `tool.before.*` or `session.idle` events; async hooks cannot block tool execution or idle dispatch
- async hooks must use only `bash` actions; `command` and `tool` actions have no timeout and can stall the queue
- async hook failures are logged but not retried; async execution is best-effort and not guaranteed to complete if the host process exits

## Explicit non-goals for v1/v2 runtime scope

This package does **not** currently try to:

- define custom hook events beyond session, file, and tool lifecycle events
- provide config inheritance or override priority beyond global-then-project merging
- provide retries, scheduling, or concurrency controls per hook
- track arbitrary filesystem changes outside OpenCode mutation tools
- make command or tool actions blocking

## Development

```bash
npm install
npm run build
npm test
```
