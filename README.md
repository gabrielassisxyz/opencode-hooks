# opencode-hooks

Standalone OpenCode plugin package scaffold for the reusable hooks runtime.

## Status

This lane establishes the base package structure, Bun build pipeline, and a typed plugin entrypoint. Runtime behavior, hook parsing, and execution flow land in later lanes.

## Scripts

- `npm install`
- `npm run typecheck`
- `npm run build`
- `npm test`

## Layout

```text
src/
  adapter/
    opencode.ts
  core/
    runtime.ts
  index.ts
test/
  plugin.test.ts
```

## Entry point

`src/index.ts` exports a default async function typed as `Plugin` and currently returns an empty hook set through the adapter stub.
