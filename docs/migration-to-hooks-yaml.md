# Migration to `hooks.yaml`

This guide is for operators moving from older examples based on `hooks.md`, YAML frontmatter, and `isMainSession`.

## What changed

The current runtime on this branch expects:

- `hooks.yaml` files, not `hooks.md`
- top-level YAML with a `hooks:` array, not Markdown with frontmatter
- `scope` and `runIn` for session targeting, not `isMainSession`
- `file.changed` as the preferred public API for file automation

## Old versus new locations

### Old pattern

```text
~/.config/opencode/hook/hooks.md
<project>/.opencode/hook/hooks.md
```

### New pattern

```text
~/.config/opencode/hook/hooks.yaml
<project>/.opencode/hook/hooks.yaml
```

On Windows, the runtime also supports `%APPDATA%/opencode/hook/hooks.yaml` when the preferred global file does not exist.

## Old versus new file shape

### Old `hooks.md` style

```markdown
---
hooks:
  - event: session.idle
    conditions: [hasCodeChange, isMainSession]
    actions:
      - bash: "npm test"
---
```

### New `hooks.yaml` style

```yaml
hooks:
  - event: session.idle
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash: "npm test"
```

## Default values to know during migration

These defaults are now explicit:

- `scope` defaults to `all`
- `runIn` defaults to `current`
- `conditions` are optional
- bash `timeout` defaults to `60000` milliseconds

If your old config relied on implicit behavior, check whether you actually need to set `scope`, `runIn`, or `timeout` at all.

## Replacing `isMainSession`

## If your old config meant “only run in the root session”

Replace:

```yaml
conditions: [isMainSession]
```

with:

```yaml
scope: main
```

## If your old config meant “allow child sessions to trigger the hook, but run follow-up work in the root session”

Use:

```yaml
scope: all
runIn: main
```

That means:

- main and child sessions can trigger the hook
- command and tool actions execute in the main session

## If your old config only made sense for child sessions

Use:

```yaml
scope: child
```

## Move file automations from `tool.after.*` to `file.changed`

This is the most important behavioral migration.

### Old pattern

```yaml
hooks:
  - event: tool.after.*
    actions:
      - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
```

Problems with the old pattern:

- it runs after every tool, not only file mutation tools
- file intent is ambiguous
- scripts have to inspect raw tool payloads instead of normalized file change data

### New recommended pattern

```yaml
hooks:
  - event: file.changed
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash: "$HOME/.config/opencode/hook/atomic-commit.sh"
```

Why this is better:

- it only fires when supported mutation tools change files
- it includes `files` and structured `changes`
- it matches the public API the runtime is now documenting and stabilizing

## Migration examples

## Example 1: main-session idle checks

Before:

```markdown
---
hooks:
  - event: session.idle
    conditions: [hasCodeChange, isMainSession]
    actions:
      - bash:
          command: "npm run lint --fix"
          timeout: 30000
      - command: simplify-changes
---
```

After:

```yaml
hooks:
  - event: session.idle
    scope: main
    conditions: [hasCodeChange]
    actions:
      - bash:
          command: "npm run lint --fix"
          timeout: 30000
      - command: simplify-changes
```

## Example 2: child-triggered main-session review

Before:

```markdown
---
hooks:
  - event: session.created
    conditions: [isMainSession]
    actions:
      - command:
          name: review-pr
          args: "main feature"
---
```

After, if only the main session should trigger it:

```yaml
hooks:
  - event: session.created
    scope: main
    actions:
      - command:
          name: review-pr
          args: "main feature"
```

After, if child sessions should trigger the review in main:

```yaml
hooks:
  - event: file.changed
    scope: all
    runIn: main
    conditions: [hasCodeChange]
    actions:
      - command:
          name: review-pr
          args: "main feature"
```

## Example 3: advanced low-level hook kept as low-level hook

Some hooks should stay low-level.

```yaml
hooks:
  - event: tool.after.*
    actions:
      - bash: |
          context=$(cat)
          echo "advanced after hook for $(echo "$context" | jq -r '.tool_name')"
```

Keep this style only for observability or truly tool-specific workflows.

## Recommended migration checklist

1. Rename `hooks.md` to `hooks.yaml`.
2. Remove Markdown frontmatter markers.
3. Replace `isMainSession` with `scope: main`, `scope: child`, or `scope` plus `runIn`.
4. Move file automations from `tool.after.*` to `file.changed` where possible.
5. Remove unnecessary explicit settings when defaults already match what you want.
6. Re-check any script that assumed raw tool payloads and update it to use `files` and `changes`.

## Things that do not change

- hook actions still run in declaration order
- global config still loads before project config
- only bash actions on `tool.before.*` and `tool.before.<name>` can block with exit code `2`
- invalid config reloads still keep the last known good hook set active

## When to keep low-level tool hooks

Keep `tool.before.*`, `tool.before.<name>`, `tool.after.*`, or `tool.after.<name>` when you need:

- a blocking policy gate before tool execution
- observability for all tools, not only file mutations
- tool-specific behavior that is not fundamentally about changed files

If your workflow is really “react to changed files,” migrate to `file.changed`.
