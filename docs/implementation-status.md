# Implementation status

This document describes the current behavior on branch `epic/c6d9dfbe-hooks-runtime`, what the v2 docs formalize, and what limitations still remain.

## Executive summary

The runtime on this branch already uses the `hooks.yaml` config shape and supports the v2-facing public API described in the new docs:

- `scope` and `runIn` are first-class hook fields
- `file.changed` is emitted after supported file mutation tools
- `scope` defaults to `all`
- `runIn` defaults to `current`
- `conditions` are optional
- bash action `timeout` defaults to `60000` ms
- invalid config reloads keep the last known good config active

The documentation work in this task is primarily making those contracts explicit and steering operators away from older patterns such as `hooks.md`, `isMainSession`, and catch-all `tool.after.*` file automations.

## What is implemented today

### Config discovery and loading

Current discovery paths:

- global: `~/.config/opencode/hook/hooks.yaml`
- project: `<project>/.opencode/hook/hooks.yaml`
- Windows fallback: `%APPDATA%/opencode/hook/hooks.yaml` when the preferred global path does not exist

Current load behavior:

- global hooks load first
- project hooks load second
- hooks are combined by event, not overridden
- only existing files are loaded
- parse and validation errors are logged
- on reload, invalid changes do not replace the active config set

### Supported events

Session and file events:

- `session.created`
- `session.deleted`
- `session.idle`
- `file.changed`

Tool events:

- `tool.before.*`
- `tool.before.<name>`
- `tool.after.*`
- `tool.after.<name>`

### Supported conditions

Only one condition exists today:

- `hasCodeChange`

It passes when at least one tracked changed path has a supported extension. This is extension-based, so extensionless files such as `Dockerfile` do not currently count.

### Supported actions

- `command`
- `tool`
- `bash`

Blocking is limited to bash actions on `tool.before.*` and `tool.before.<name>` when the process exits with code `2`.

### Session scoping and action routing

Current public controls:

- `scope: all | main | child`
- `runIn: current | main`

Current defaults:

- `scope` defaults to `all`
- `runIn` defaults to `current`

This replaces the older operator pattern of encoding session intent through conditions like `isMainSession`.

### File change tracking

The runtime tracks file changes from these tool names:

- `write`
- `edit`
- `multiedit`
- `patch`
- `apply_patch`

Normalized output:

- direct mutation tools produce `modify` records for their target file
- patch tools parse `*** Add File`, `*** Update File`, `*** Delete File`, and `*** Move to` headers
- renames emit structured `{ operation: "rename", fromPath, toPath }` entries

`file.changed` is dispatched immediately after those changes are captured in `tool.execute.after`.

### Idle replay behavior

Current idle behavior is safer than earlier iterations:

- `session.idle` snapshots tracked changes before dispatch
- the tracked list is only cleared after dispatch completes successfully
- if dispatch fails, the pending tracked changes remain available for retry
- changes replayed during an active idle dispatch are preserved for the next cycle

### Reload behavior

Current reload behavior is deterministic:

- discovered configs are re-read at each runtime entrypoint
- if a changed config is invalid, the runtime logs the error
- the last known good hook set remains active
- once the config is fixed, the next runtime event activates it without a restart

## What “v2” changed for operators

The v2 documentation is not inventing a new runtime separate from this branch. It is formalizing the branch's current public contract and recommended usage.

Key operator-facing changes from older docs and examples:

1. `hooks.yaml` is the supported config file.
2. `scope` and `runIn` replace `isMainSession`-style routing.
3. `file.changed` is the preferred public API for file automation.
4. `tool.after.write` and related hooks remain available, but are now documented as advanced options.
5. Defaults are documented explicitly instead of leaving operators to infer them from implementation.

## Issue-by-issue status

### Config brittleness

Status: improved, but validation is still strict by design.

What changed on this branch:

- the runtime validates the config shape explicitly
- invalid reloads do not wipe out the last working configuration

What still matters:

- malformed YAML or unsupported values still prevent new config from activating
- operators still need exact event names and valid action shapes

### Mutation alias drift

Status: addressed for patch aliases.

What changed on this branch:

- tool names `patch` and `apply_patch` are normalized together
- hook matching for patch tools supports both names
- file change extraction accepts `patchText`, `patch`, or `diff`

Remaining caveat:

- tool-specific hooks still depend on actual emitted OpenCode tool names outside the normalized mutation set

### Session scope gaps

Status: materially improved.

What changed on this branch:

- scope is a first-class field with `all`, `main`, and `child`
- root-session resolution walks parent links and caches resolved roots
- `runIn: main` can route command and tool actions to the root session

Remaining caveat:

- routing depends on session parent information being available from the OpenCode session API

### Idle race and lost-change handling

Status: improved.

What changed on this branch:

- idle dispatch snapshots pending changes
- failed idle dispatches do not clear tracked changes
- replayed changes during idle are preserved for the next cycle

Remaining caveat:

- tracking is still limited to supported OpenCode mutation tools, not external file edits

### Weak observability

Status: partially improved.

What changed on this branch:

- bash failures log structured details including event, session, cwd, duration, command, stdout, and stderr
- reload errors are logged with file and validation path context

Remaining caveat:

- observability is still console-log based; there is no built-in event history UI or metrics layer

### Risky examples

Status: improved by documentation.

What changed on this branch:

- operator docs now steer users toward `file.changed`
- examples explicitly describe `tool.after.*` as advanced
- atomic commit guidance is framed as a conservative, file-scoped pattern

Remaining caveat:

- low-level hooks are still powerful enough to create noisy or unsafe automation if used without care

### Reload limitations

Status: improved, not eliminated.

What changed on this branch:

- the runtime checks for config changes at each hook entrypoint
- invalid configs do not replace the active set

Remaining caveat:

- reloads are event-driven, so a saved config change is not applied until the next relevant runtime event

## Recommended usage on this branch

Use this as the default decision tree:

### Use `file.changed` when

- you care about changed files
- you want structured `changes` metadata
- you want lint/format/test/index/commit flows tied to file mutations

### Use `session.idle` when

- you want to batch work after a burst of edits
- you only need the accumulated changed-path set for the current session

### Use `tool.before.*` or `tool.before.<name>` when

- you need a policy gate that can block tool execution
- you want to reject sensitive writes or other prohibited operations

### Use `tool.after.*` or `tool.after.<name>` when

- you need tool-level observability
- your workflow is not fundamentally file-oriented
- you understand you are working below the preferred public API

## Current known limitations

- only `hooks.yaml` is discovered; older `hooks.md` files are not read
- `hasCodeChange` is extension-based
- file tracking only covers supported mutation tools
- bash execution uses `/bin/sh` and therefore requires a working shell environment
- command and tool actions are non-blocking even when they fail
- there are no per-hook retries, concurrency controls, or scheduling features

## Bottom line

For operators, the branch is ready to be documented as a `hooks.yaml` runtime with explicit scope/runIn defaults and a preferred `file.changed` API. The remaining gaps are mostly around observability breadth, extension-based heuristics, and the fact that advanced tool hooks are still easy to misuse if treated as the default path.
