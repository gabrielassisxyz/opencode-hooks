# Comparison with Claude Code hooks

This document compares the hook systems in **opencode-hooks** (this plugin for OpenCode) and **Claude Code** (Anthropic's CLI). Both enable automation at key points in the agent lifecycle, but they differ significantly in architecture, execution model, and async behavior.

## Architecture overview

| Aspect | Claude Code | opencode-hooks |
|---|---|---|
| Host | TypeScript embedded in CLI binary | TypeScript plugin for OpenCode |
| Config format | JSON in `settings.json` | YAML in `hooks.yaml` |
| Hook types | 4: `command`, `http`, `prompt`, `agent` | 3 action types: `bash`, `command`, `tool` |
| Execution model | All matching hooks run **in parallel**, deduplicated | Hooks run **sequentially** in declaration order |
| Event count | 22 lifecycle events | 8 events (4 session + 4 tool phases) |
| Discovery | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, plugin frontmatter | `~/.config/opencode/hook/hooks.yaml`, `<project>/.opencode/hook/hooks.yaml` |

## Event mapping

Claude Code has 22 lifecycle events; opencode-hooks has 8 that cover the most common automation scenarios.

| Claude Code event | opencode-hooks equivalent | Notes |
|---|---|---|
| `PreToolUse` | `tool.before.*`, `tool.before.<name>` | Both support blocking via exit code 2 |
| `PostToolUse` | `tool.after.*`, `tool.after.<name>` | Both are non-blocking |
| `PostToolUse` (file edits) | `file.changed` | opencode-hooks adds a synthetic event with structured change metadata |
| `SessionStart` | `session.created` | Similar purpose |
| `Stop` | `session.idle` | Closest equivalent; idle fires when the session becomes idle |
| — | `session.deleted` | No Claude Code equivalent |
| `Notification` | — | No opencode-hooks equivalent |
| `SubagentStart`/`SubagentStop` | — | No opencode-hooks equivalent |
| `PermissionRequest` | — | No opencode-hooks equivalent |
| `ConfigChange` | — | No opencode-hooks equivalent |
| `SessionEnd` | — | No opencode-hooks equivalent |
| `WorktreeCreate`/`WorktreeRemove` | — | No opencode-hooks equivalent |
| `PreCompact`/`PostCompact` | — | No opencode-hooks equivalent |

## Hook definition comparison

### Claude Code

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write $(jq -r '.tool_input.file_path')",
            "async": false,
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

### opencode-hooks

```yaml
hooks:
  - event: file.changed
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash:
          command: "npx prettier --write"
          timeout: 30000
```

### Key structural differences

- Claude Code groups hooks by event, then by matcher, then by handler. opencode-hooks uses a flat list with per-hook event and conditions.
- Claude Code matchers are regex patterns on tool names. opencode-hooks uses `conditions` (like `hasCodeChange`) and event-level filtering (`tool.after.write`).
- Claude Code supports `http`, `prompt`, and `agent` hook types alongside `command`. opencode-hooks supports `bash`, `command` (OpenCode slash commands), and `tool` (prompt-based tool invocation).

## Async behavior

Both systems support an `async: true` flag that makes hooks non-blocking. The key differences are in **what happens after the hook is detached**.

### Claude Code async

```json
{
  "type": "command",
  "command": "./my-script.sh",
  "async": true
}
```

- Pure fire-and-forget: the process is spawned and detached
- **No serialization**: rapid-fire edits spawn concurrent async hooks
- Output (stdout, stderr, exit codes) is **discarded**
- Standard timeout still applies (default 600 seconds)
- Available on `command` type hooks only
- No restriction on which events support async

### opencode-hooks async

```yaml
hooks:
  - event: file.changed
    async: true
    actions:
      - bash: "./my-script.sh"
```

- Fire-and-forget from the caller's perspective: the OpenCode tool pipeline is unblocked immediately
- **Serialized per event+session**: rapid-fire edits are queued, not concurrent
- Output is discarded; errors are caught and logged
- Bash timeout still applies to the background action
- Available on all action types (`bash`, `command`, `tool`)
- **Rejected at parse time** on `tool.before.*` events (blocking requires synchronous execution)

### Why serialization matters

This is the most significant design difference. Consider an atomic commit hook that runs on every file edit:

**Claude Code** (no serialization):

```
edit file A → async hook spawns → git add + git commit
edit file B → async hook spawns → git add + git commit  ← concurrent!
edit file C → async hook spawns → git add + git commit  ← concurrent!
```

Three concurrent `git commit` operations fight over `.git/index.lock`. The second and third fail.

**opencode-hooks** (serialized queue):

```
edit file A → queued → git add + git commit
edit file B → queued →                       git add + git commit
edit file C → queued →                                              git add + git commit
```

Each commit waits for the previous one to finish. No lock conflicts.

The serialization is per `${event}:${sessionID}`. Different events or different sessions run independently.

### Error handling difference

Claude Code's `Plugin.trigger` equivalent runs hooks inside its own process with full error handling. opencode-hooks runs inside OpenCode's plugin host, where `Plugin.trigger()` has **no try-catch** around hook invocations:

```typescript
// OpenCode's actual Plugin.trigger code (sst/opencode)
for (const hook of await state().then((x) => x.hooks)) {
  const fn = hook[name]
  if (!fn) continue
  await fn(input, output)  // no try-catch!
}
```

An unhandled rejection from our plugin would crash the OpenCode process. This is why opencode-hooks wraps every async fire-and-forget path in a mandatory `.catch()` that logs the error instead of propagating it.

Claude Code hooks run in a child process, so a crashing hook script doesn't affect the parent.

## Features unique to each system

### Claude Code has, opencode-hooks does not

| Feature | Description |
|---|---|
| Parallel hook execution | All matching hooks run simultaneously, with deduplication by command/URL |
| HTTP hooks | POST event data to a URL endpoint |
| Prompt hooks | Single-turn LLM evaluation for judgment-based decisions |
| Agent hooks | Multi-turn agent with tool access for verification |
| `once: true` | Run a hook only once per session |
| Structured JSON output | Hooks can modify tool inputs, inject context, control permissions |
| Regex matchers | Filter hooks by tool name pattern |
| 22 lifecycle events | Rich event surface including compaction, config changes, worktrees |
| `PermissionRequest` hooks | Auto-approve or deny permission dialogs |
| `SessionEnd` hooks | Run cleanup when session terminates |
| `CLAUDE_ENV_FILE` | Persist environment variables from `SessionStart` hooks |
| `/hooks` inspector | Read-only browser showing all configured hooks |

### opencode-hooks has, Claude Code does not

| Feature | Description |
|---|---|
| Serialized async queue | Prevents concurrent races for stateful side effects |
| Hook overrides | Project-level YAML can override or disable global hooks by `id` |
| `file.changed` event | Synthetic event with normalized change metadata across mutation tools |
| Session scope | `main`/`child`/`all` routing based on session hierarchy |
| `runIn` targeting | Execute actions in the root session from child sessions |
| Structured change metadata | `changes` array with `operation`, `path`, `fromPath`, `toPath` |
| Condition system | `hasCodeChange` filters hooks by file extension |
| Hot reload with validation | Invalid YAML reloads are rejected; last known good config stays active |

## When to use which

If you are using **OpenCode**, use opencode-hooks. If you are using **Claude Code**, use Claude Code's built-in hooks.

If you are designing hooks that perform **stateful side effects** (git operations, database writes, file locks), the serialized async queue in opencode-hooks prevents the concurrency issues you'd need to handle yourself with Claude Code's async.

If you need **judgment-based decisions** (should this edit be allowed?), Claude Code's `prompt` and `agent` hook types give you LLM-powered evaluation without writing a separate service.
