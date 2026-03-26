# Comparison with Claude Code hooks

This is a practical comparison, not a marketing page.

If you are using OpenCode, use `opencode-yaml-hooks`. If you are using Claude Code, use Claude Code's built-in hooks. The useful question is how their hook models differ, especially if you are porting an existing workflow.

## TL;DR

`opencode-yaml-hooks` is smaller and more opinionated.

It gives you a YAML config, a focused event model, `bash` / `command` / `tool` actions, session-aware routing with `scope` and `runIn`, and a serialized async queue that is safer for stateful side effects.

Claude Code exposes a broader hook surface. This doc only treats Claude-side details as high-level context. The source of truth in this repo is the OpenCode plugin implementation.

## High-level differences

| Aspect | Claude Code | opencode-yaml-hooks |
|---|---|---|
| Host model | Built into the CLI | Runs as an OpenCode plugin |
| Config format | Settings-based config | `hooks.yaml` |
| Action model | Different hook handler types | `bash`, `command`, `tool` |
| Event model | Broader lifecycle surface | Focused session + tool lifecycle surface |
| File automation | Tool hooks | Prefer `file.changed` |
| Session targeting | Claude-specific model | `scope` + `runIn` |
| Async behavior | Has async hooks | Has async hooks, but serializes them per event and source session |
| Overrides | Claude-specific config model | Later files can override or disable earlier hooks by `id` |

## What opencode-yaml-hooks is optimized for

`opencode-yaml-hooks` is built for local automation that needs to stay predictable.

That usually means things like:

- lint or format after file edits
- run targeted tests after code changes
- block risky tool calls before they execute
- route follow-up commands back to the main session
- run git or indexing workflows without another LLM step

The design leans toward boring behavior over clever behavior. Hooks run in declaration order. `file.changed` normalizes file-change events. Async hooks are constrained so they do not quietly create races in common shell workflows.

## Event model

The OpenCode plugin supports these hook events:

- `session.created`
- `session.deleted`
- `session.idle`
- `file.changed`
- `tool.before.*`
- `tool.before.<name>`
- `tool.after.*`
- `tool.after.<name>`

That is a smaller surface than Claude Code. The tradeoff is simplicity.

The most important difference is `file.changed`. Claude-style tool hooks tell you that a tool ran. `file.changed` tells you that a supported mutation tool actually reported file changes, and it gives you normalized `files` and `changes` metadata.

For most file-oriented automation, that is the better abstraction.

## Config model

Claude Code and OpenCode do not organize hooks the same way.

`opencode-hooks` uses a flat YAML list:

```yaml
hooks:
  - id: lint-on-change
    event: file.changed
    scope: main
    conditions: [matchesCodeFiles]
    actions:
      - bash:
          command: "npm run lint -- --fix"
          timeout: 30000
```

That shape makes a few things explicit:

- `event` decides when the hook runs
- `scope` decides which sessions can trigger it
- `runIn` decides where `command` and `tool` actions execute
- `conditions` filter the hook further
- `actions` run in order

It is a straightforward model. You do not need matcher trees or nested handler structures to understand what happens.

## Action model

`opencode-hooks` supports three action types:

| Action | What it does |
|---|---|
| `bash` | Runs a shell command directly |
| `command` | Executes an OpenCode command |
| `tool` | Prompts a session to use a specific tool with arguments |

This is intentionally narrow.

The plugin is good at automation, policy checks, and session-aware follow-up work. It is not trying to be a general remote hook platform or a programmable decision engine.

## Session-aware behavior

This is one place where `opencode-hooks` is more explicit than many hook systems.

You get two separate controls:

| Field | Question it answers |
|---|---|
| `scope` | Which session can trigger this hook? |
| `runIn` | Which session should the follow-up action run in? |

Example:

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

That means a child session can trigger the hook, but the `review-pr` command still runs in the root session.

If you work with child sessions a lot, this is a genuinely useful feature.

## Async behavior

Both systems have async hooks. The important difference here is how `opencode-hooks` handles side effects.

In this plugin:

- `async: true` returns control to the caller immediately
- async hooks must use `bash` actions only
- async hooks are not allowed on `tool.before.*` or `session.idle`
- async work is serialized per event and source session

That last point matters.

If a hook runs `git add && git commit` after every edit, overlapping async jobs are a mess. They fight over locks, staging state, and timing. `opencode-hooks` avoids that by queueing those runs instead of letting them pile on top of each other.

This is one of the strongest reasons to use `file.changed` plus async `bash` hooks for stateful local workflows.

## Overrides and layering

`opencode-hooks` supports a simple layering model:

1. global hooks load first
2. project hooks load second

A later file can target an earlier hook by `id` and either:

- replace it
- disable it

Example:

```yaml
hooks:
  - override: format-on-change
    disable: true
```

This is useful when you want a strong default global config but still need project-level escape hatches.

## Where opencode-hooks is stronger

These are the main strengths of this plugin relative to the model it is trying to replace:

- `file.changed` gives you normalized file-change metadata
- `scope` and `runIn` make session routing explicit
- async work is serialized instead of overlapping for the same event and source session
- YAML overrides let project config replace or disable global defaults by `id`
- invalid config reloads are rejected, and the last known good config stays active

## Where Claude Code is broader

Claude Code has a wider built-in hook surface and more hook-specific capabilities.

This repo is not the source of truth for Claude Code behavior, so I am keeping this part intentionally high level. If you are migrating from Claude Code, the safe assumption is:

- Claude Code exposes more hook entry points
- Claude Code offers more hook-specific features
- `opencode-hooks` covers a smaller, more operationally focused slice of the problem

If your workflow mostly cares about local shell automation, file changes, tool policy checks, and session-aware command routing, `opencode-hooks` is probably enough.

If your workflow depends on Claude-specific hook features outside that slice, you will need to redesign it instead of doing a straight port.

## Porting advice

If you are moving a workflow from Claude Code to `opencode-hooks`, start here:

| If your Claude hook does this | Start with this in opencode-hooks |
|---|---|
| Run shell automation after file edits | `file.changed` + `bash` |
| Block dangerous tool calls | `tool.before.<name>` + `bash` exit code `2` |
| Observe all tool usage | `tool.after.*` + `bash` |
| Run a follow-up command in the root session | `runIn: main` + `command` |
| Limit behavior to main or child sessions | `scope: main` or `scope: child` |

Do not start with `tool.after.*` just because it looks more general. If your workflow is file-oriented, `file.changed` is usually the right hook.

## Bottom line

Claude Code appears broader. `opencode-hooks` is narrower, but sharper.

It is a good fit when you want deterministic local automation inside OpenCode, especially around file changes, session-aware routing, and stateful shell workflows that should not run concurrently.
