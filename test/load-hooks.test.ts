import os from "node:os"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { discoverHookConfigPaths, resolveHookConfigPaths } from "../src/core/config-paths.ts"
import { loadDiscoveredHooks, loadDiscoveredHooksSnapshot, parseHooksFile } from "../src/core/load-hooks.ts"

describe("parseHooksFile", () => {
  it("parses supported hook schema and preserves declaration order", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: tool.before.*
    scope: main
    runIn: main
    conditions: [hasCodeChange]
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
`,
    )

    expect(result.errors).toEqual([])
    expect(result.hooks.get("tool.before.*")).toHaveLength(1)
    expect(result.hooks.get("session.created")).toHaveLength(1)

    const toolHook = result.hooks.get("tool.before.*")?.[0]
    expect(toolHook).toMatchObject({
      event: "tool.before.*",
      scope: "main",
      runIn: "main",
      conditions: ["hasCodeChange"],
      source: { filePath: "/repo/.opencode/hook/hooks.yaml", index: 0 },
    })
    expect(toolHook?.actions).toEqual([
      { bash: { command: "npm test", timeout: 30000 } },
      { command: { name: "review-pr", args: "main feature" } },
    ])
  })

  it("rejects invalid hook entries without crashing", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: nope
    actions:
      - command: review-pr
  - event: session.idle
    scope: project
    actions:
      - bash:
          command: npm test
          timeout: fast
  - event: session.created
    actions: invalid
`,
    )

    expect(Array.from(result.hooks.values()).flat()).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_event", path: "hooks[0].event" }),
      expect.objectContaining({ code: "invalid_scope", path: "hooks[1].scope" }),
      expect.objectContaining({ code: "invalid_action", path: "hooks[1].actions[0].bash" }),
      expect.objectContaining({ code: "invalid_actions", path: "hooks[2].actions" }),
    ])
  })

  it("applies v2 defaults and points top-level validation errors at exact keys", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: session.idle
    actions:
      - command: simplify-changes
`,
    )

    expect(result.errors).toEqual([])
    expect(result.hooks.get("session.idle")?.[0]).toMatchObject({
      scope: "all",
      runIn: "current",
    })

    expect(parseHooksFile("/repo/.opencode/hook/hooks.yaml", "notHooks: []").errors).toEqual([
      expect.objectContaining({ code: "missing_hooks", path: "hooks" }),
    ])

    expect(parseHooksFile("/repo/.opencode/hook/hooks.yaml", "hooks: invalid").errors).toEqual([
      expect.objectContaining({ code: "invalid_hooks", path: "hooks" }),
    ])
  })
})

describe("hook config discovery", () => {
  it("uses APPDATA as a Windows fallback when ~/.config is absent", () => {
    const resolved = resolveHookConfigPaths({
      platform: "win32",
      homeDir: "C:/Users/tester",
      appDataDir: "C:/Users/tester/AppData/Roaming",
      exists: () => false,
    })

    expect(resolved.global).toBe(path.join("C:/Users/tester/AppData/Roaming", "opencode", "hook", "hooks.yaml"))
  })

  it("discovers existing files in deterministic global-then-project order", () => {
    const homeDir = path.join(os.tmpdir(), "home")
    const projectDir = "/repo/project"
    const existing = new Set([
      path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml"),
      path.join(projectDir, ".opencode", "hook", "hooks.yaml"),
    ])

    const paths = discoverHookConfigPaths({
      projectDir,
      platform: "darwin",
      homeDir,
      exists: (filePath) => existing.has(filePath),
    })

    expect(paths).toEqual([
      path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml"),
      path.join(projectDir, ".opencode", "hook", "hooks.yaml"),
    ])
  })

  it("merges global hooks before project hooks", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    const files = new Map([
      [globalPath, `hooks:
  - event: session.idle
    actions:
      - command: global
`],
      [projectPath, `hooks:
  - event: session.idle
    actions:
      - command: project
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? "",
    })

    expect(result.files).toEqual([globalPath, projectPath])
    expect(result.errors).toEqual([])
    expect(result.hooks.get("session.idle")?.map((hook) => hook.actions[0])).toEqual([
      { command: "global" },
      { command: "project" },
    ])
  })

  it("preserves per-file declaration order while merging discovered hook files", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    const files = new Map([
      [globalPath, `hooks:
  - event: tool.before.write
    actions:
      - command: global-first
  - event: tool.before.write
    actions:
      - command: global-second
`],
      [projectPath, `hooks:
  - event: tool.before.write
    actions:
      - command: project-first
  - event: tool.before.write
    actions:
      - command: project-second
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? "",
    })

    expect(result.hooks.get("tool.before.write")?.map((hook) => hook.actions[0])).toEqual([
      { command: "global-first" },
      { command: "global-second" },
      { command: "project-first" },
      { command: "project-second" },
    ])
  })

  it("keeps valid hooks while reporting invalid hooks from discovered files", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    const files = new Map([
      [globalPath, `hooks:
  - event: tool.before.write
    actions:
      - command: global-valid
  - event: invalid.event
    actions:
      - command: global-invalid
`],
      [projectPath, `hooks:
  - event: tool.before.write
    actions:
      - command: project-valid
  - event: session.idle
    actions: invalid
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? "",
    })

    expect(result.hooks.get("tool.before.write")?.map((hook) => hook.actions[0])).toEqual([
      { command: "global-valid" },
      { command: "project-valid" },
    ])
    expect(result.errors).toEqual([
      expect.objectContaining({ filePath: globalPath, code: "invalid_event", path: "hooks[1].event" }),
      expect.objectContaining({ filePath: projectPath, code: "invalid_actions", path: "hooks[1].actions" }),
    ])
  })

  it("builds a stable snapshot signature from discovered hooks.yaml contents", () => {
    const projectDir = "/repo/project"
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    let projectFile = `hooks:
  - event: session.created
    actions:
      - command: first
`

    const readSnapshot = () => loadDiscoveredHooksSnapshot({
      projectDir,
      exists: (filePath) => filePath === projectPath,
      readFile: () => projectFile,
    })

    const first = readSnapshot()
    const second = readSnapshot()
    projectFile = `hooks:
  - event: session.created
    actions:
      - command: second
`
    const third = readSnapshot()

    expect(first.signature).toBe(second.signature)
    expect(third.signature).not.toBe(first.signature)
  })

  it("returns validation errors when hooks.yaml cannot be read", () => {
    const projectDir = "/repo/project"
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")

    const result = loadDiscoveredHooks({
      projectDir,
      exists: (filePath) => filePath === projectPath,
      readFile: () => {
        throw new Error("busy")
      },
    })

    expect(result.hooks.size).toBe(0)
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "invalid_frontmatter",
        filePath: projectPath,
        message: "Failed to read hooks.yaml: busy",
      }),
    ])
  })
})
