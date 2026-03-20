import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { discoverHookConfigPaths, resolveHookConfigPaths } from "../src/core/config-paths.ts"
import { loadDiscoveredHooks, parseHooksFile } from "../src/core/load-hooks.ts"

describe("parseHooksFile", () => {
  it("parses supported hook schema and preserves declaration order", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.md",
      `---
hooks:
  - event: tool.before.*
    conditions: [isMainSession, hasCodeChange]
    actions:
      - bash:
          command: npm test
          timeout: 30000
      - command:
          name: review-pr
          args: main feature
  - event: session.created
    actions:
      - tool:
          name: bash
          args:
            command: echo ready
---
body ignored
`,
    )

    expect(result.errors).toEqual([])
    expect(result.hooks.get("tool.before.*")).toHaveLength(1)
    expect(result.hooks.get("session.created")).toHaveLength(1)

    const toolHook = result.hooks.get("tool.before.*")?.[0]
    expect(toolHook).toMatchObject({
      event: "tool.before.*",
      conditions: ["isMainSession", "hasCodeChange"],
      source: { filePath: "/repo/.opencode/hook/hooks.md", index: 0 },
    })
    expect(toolHook?.actions).toEqual([
      { bash: { command: "npm test", timeout: 30000 } },
      { command: { name: "review-pr", args: "main feature" } },
    ])
  })

  it("rejects invalid hook entries without crashing", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.md",
      `---
hooks:
  - event: nope
    actions:
      - command: review-pr
  - event: session.idle
    conditions: mainOnly
    actions:
      - bash:
          command: npm test
          timeout: fast
  - event: session.created
    actions: invalid
---
`,
    )

    expect(Array.from(result.hooks.values()).flat()).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_event", path: "hooks[0].event" }),
      expect.objectContaining({ code: "invalid_conditions", path: "hooks[1].conditions" }),
      expect.objectContaining({ code: "invalid_action", path: "hooks[1].actions[0].bash" }),
      expect.objectContaining({ code: "invalid_actions", path: "hooks[2].actions" }),
    ])
  })
})

describe("hook config discovery", () => {
  it("uses APPDATA as a Windows fallback when ~/.config is absent", () => {
    const resolved = resolveHookConfigPaths({
      platform: "win32",
      homeDir: "C:/Users/tester",
      appDataDir: "C:/Users/tester/AppData/Roaming",
    })

    expect(resolved.global).toBe(path.join("C:/Users/tester/AppData/Roaming", "opencode", "hook", "hooks.md"))
  })

  it("discovers existing files in deterministic global-then-project order", () => {
    const homeDir = path.join(os.tmpdir(), "home")
    const projectDir = "/repo/project"
    const existing = new Set([
      path.join(homeDir, ".config", "opencode", "hook", "hooks.md"),
      path.join(projectDir, ".opencode", "hook", "hooks.md"),
    ])

    const paths = discoverHookConfigPaths({
      projectDir,
      platform: "darwin",
      homeDir,
      exists: (filePath) => existing.has(filePath),
    })

    expect(paths).toEqual([
      path.join(homeDir, ".config", "opencode", "hook", "hooks.md"),
      path.join(projectDir, ".opencode", "hook", "hooks.md"),
    ])
  })

  it("merges global hooks before project hooks", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.md")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.md")
    const files = new Map([
      [globalPath, `---
hooks:
  - event: session.idle
    actions:
      - command: global
---
`],
      [projectPath, `---
hooks:
  - event: session.idle
    actions:
      - command: project
---
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
    })

    expect(result.files).toEqual([globalPath, projectPath])
    expect(result.errors).toEqual([])
    expect(result.hooks.get("session.idle")?.map((hook) => hook.actions[0])).toEqual([
      { command: "global" },
      { command: "project" },
    ])
  })
})
