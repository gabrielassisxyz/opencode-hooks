# opencode-hooks

Standalone OpenCode plugin that loads hook definitions from `hooks.md` files and runs command, tool, or bash actions on session and tool lifecycle events.

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

## What v1 does

The runtime:

- discovers hook configs from standard OpenCode hook locations
- parses YAML frontmatter from `hooks.md`
- validates supported events, conditions, and action shapes
- dispatches hooks for session lifecycle events and tool lifecycle events
- lets `tool.before.*` hooks block a tool when a bash action exits with code `2`
- tracks files modified through `write`, `edit`, `multiedit`, and `apply_patch`

## Hook config locations

Hooks are merged from global and project locations.

| Platform | Global config | Project config |
|---|---|---|
| macOS / Linux | `~/.config/opencode/hook/hooks.md` | `<project>/.opencode/hook/hooks.md` |
| Windows | `~/.config/opencode/hook/hooks.md` preferred, otherwise `%APPDATA%/opencode/hook/hooks.md` | `<project>/.opencode/hook/hooks.md` |

Behavior:

- global hooks load first
- project hooks load second
- matching hooks are combined, not overridden
- only existing files are loaded

## hooks.md format

Each config file must start with YAML frontmatter delimited by `---` and must define a top-level `hooks` array.

```markdown
---
hooks:
  - event: session.idle
    conditions: [hasCodeChange, isMainSession]
    actions:
      - bash: "npm run lint --fix"
      - command: simplify-changes
---
```

### Frontmatter schema

```yaml
hooks:
  - event: <hook-event>
    conditions:            # optional
      - isMainSession
      - hasCodeChange
    actions:               # required, non-empty
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

- frontmatter must parse to an object
- `hooks` must exist and be an array
- each hook must be an object with a supported `event`
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

### Tool events

| Event | When it fires |
|---|---|
| `tool.before.*` | Before every tool execution |
| `tool.before.<name>` | Before a specific tool, such as `tool.before.write` |
| `tool.after.*` | After every tool execution |
| `tool.after.<name>` | After a specific tool, such as `tool.after.edit` |

Tool hook order for a tool named `write`:

1. `tool.before.*`
2. `tool.before.write`
3. tool executes
4. `tool.after.*`
5. `tool.after.write`

## Conditions

All configured conditions must pass for a hook to run.

| Condition | Meaning |
|---|---|
| `isMainSession` | Run only for the main session, not child sessions |
| `hasCodeChange` | Run only when tracked modified files include at least one supported code extension |

Extensions treated as code by `hasCodeChange`:

`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `json`, `yml`, `yaml`, `toml`, `css`, `scss`, `sass`, `less`, `html`, `vue`, `svelte`, `go`, `rs`, `c`, `h`, `cpp`, `cc`, `cxx`, `hpp`, `java`, `py`, `rb`, `php`, `sh`, `bash`, `kt`, `kts`, `swift`, `m`, `mm`, `cs`, `fs`, `scala`, `clj`, `hs`, `lua`.

## Actions

### Command action

Runs an OpenCode command in the same session.

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

Runs a shell command directly without another LLM step.

```yaml
actions:
  - bash: "npm run lint"
  - bash:
      command: "$OPENCODE_PROJECT_DIR/.opencode/hooks/init.sh"
      timeout: 30000
```

If `timeout` is omitted, bash actions use the runtime default of `60000` milliseconds.

## Bash contract

For bash actions, the runtime passes both environment variables and JSON over stdin.

### Environment variables

| Variable | Value |
|---|---|
| `OPENCODE_PROJECT_DIR` | Absolute project path |
| `OPENCODE_SESSION_ID` | Current OpenCode session id |

### Stdin JSON

Every bash action receives JSON like:

```json
{
  "session_id": "abc123",
  "event": "session.idle",
  "cwd": "/path/to/project",
  "files": ["src/index.ts"]
}
```

For tool hooks, the runtime also sends tool context:

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

### Exit code semantics

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `2` | Blocking failure for `tool.before.*` hooks |
| anything else | Non-blocking failure; later actions still run |

## Blocking semantics

Only `tool.before.*` and `tool.before.<name>` hooks can block tool execution.

- a bash action that exits with `2` marks the hook result as blocking
- the runtime stops remaining actions for that hook chain
- the tool call throws with the bash stderr text, or `Blocked by hook` if stderr is empty
- `tool.after.*`, `tool.after.<name>`, and session hooks do not block execution

## Execution behavior

- hooks for the same event run in declaration order
- global hooks are appended before project hooks for the same event
- action failures are logged and later actions continue unless a blocking `tool.before` bash action exits with `2`
- `session.idle` only sees files tracked from OpenCode mutation tools in the current session
- after `session.idle` dispatch completes, that session's tracked modified-file list is cleared

Example: block writes to secret files.

```yaml
hooks:
  - event: tool.before.write
    actions:
      - bash: |
          file=$(cat | jq -r '.tool_args.filePath // .tool_args.file_path // .tool_args.path')
          if echo "$file" | grep -qE '\.(env|pem|key)$'; then
            echo "Cannot modify sensitive files: $file" >&2
            exit 2
          fi
```

## Modified file tracking

The runtime records changed paths per session so `session.idle` hooks can react to what was edited.

Tracked mutation tools:

- `write`
- `edit`
- `multiedit`
- `apply_patch`

Behavior details:

- `write`, `edit`, and `multiedit` track a single file path from args such as `filePath`
- `apply_patch` parses `*** Add File`, `*** Update File`, and `*** Delete File` headers from the patch text
- paths are stored per session until the next `session.idle`
- when `session.idle` fires, the runtime passes the accumulated `files` array to hook actions and then clears that list
- `hasCodeChange` checks those tracked paths, so docs-only edits like `README.md` will not satisfy the condition

## Examples

See [`examples/hooks.md`](examples/hooks.md) for a copy-pasteable operator guide that covers all supported events.

### Minimal project-local file

Create `<project>/.opencode/hook/hooks.md`:

```markdown
---
hooks:
  - event: session.idle
    conditions: [hasCodeChange]
    actions:
      - bash: "npm test"
---
```

### Review-on-session-start

```yaml
hooks:
  - event: session.created
    conditions: [isMainSession]
    actions:
      - command:
          name: review-pr
          args: "main feature"
```

### Manual review checklist for supported events

This README includes examples or event references for every supported event:

- `session.created`
- `session.deleted`
- `session.idle`
- `tool.before.*`
- `tool.before.<name>`
- `tool.after.*`
- `tool.after.<name>`

## Explicit non-goals for v1

This package intentionally does **not** try to do the following in v1:

- define custom hook events beyond session and tool lifecycle events
- support config inheritance, overrides, or priority rules beyond global-then-project merging
- provide per-hook retries, concurrency controls, or scheduling
- track arbitrary filesystem changes outside OpenCode mutation tools
- treat non-bash actions as blocking; only `tool.before` bash hooks can block
- add a separate plugin-specific config file beyond standard `hooks.md` locations

## Development

```bash
npm install
npm run build
npm test
```
