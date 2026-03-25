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
    action: stop
    scope: main
    runIn: main
    conditions: [matchesCodeFiles]
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
      action: "stop",
      scope: "main",
      runIn: "main",
      conditions: ["matchesCodeFiles"],
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

  it("validates hook-level action: stop", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: tool.before.bash
    action: stop
    actions:
      - bash: echo ok
  - event: session.idle
    action: stop
    actions:
      - bash: echo nope
  - event: tool.after.write
    action: stop
    actions:
      - bash: echo nope
  - event: tool.before.write
    action: abort
    actions:
      - bash: echo nope
`,
    )

    expect(result.hooks.get("tool.before.bash")).toEqual([expect.objectContaining({ action: "stop" })])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_hook_action", path: "hooks[1].action" }),
      expect.objectContaining({ code: "invalid_hook_action", path: "hooks[2].action" }),
      expect.objectContaining({ code: "invalid_hook_action", path: "hooks[3].action" }),
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

  it("reports invalid runIn and legacy conditions while keeping valid hooks", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: session.created
    runIn: child
    actions:
      - bash: invalid-run-in
  - event: session.idle
    conditions: [matchesCodeFile]
    actions:
      - bash: invalid-condition
  - event: tool.after.write
    scope: child
    runIn: main
    conditions: [matchesCodeFiles]
    actions:
      - bash: valid
`,
    )

    expect(result.hooks.get("tool.after.write")).toEqual([
      expect.objectContaining({
        scope: "child",
        runIn: "main",
        conditions: ["matchesCodeFiles"],
      }),
    ])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_run_in", path: "hooks[0].runIn" }),
      expect.objectContaining({ code: "invalid_conditions", path: "hooks[1].conditions[0]" }),
    ])
  })

  it("parses hook ids, detects duplicates, and collects overrides", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - id: base-hook
    event: session.created
    actions:
      - command: first
  - id: base-hook
    event: session.idle
    actions:
      - command: duplicate
  - override: base-hook
    event: session.deleted
    actions:
      - command: replacement
  - override: base-hook
    disable: true
`,
    )

    expect(result.hooks.get("session.created")).toEqual([
      expect.objectContaining({ id: "base-hook" }),
    ])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "duplicate_hook_id", path: "hooks[1].id" }),
    ])
    expect(result.overrides).toEqual([
      expect.objectContaining({
        targetId: "base-hook",
        disable: false,
        replacement: expect.objectContaining({ event: "session.deleted" }),
      }),
      expect.objectContaining({ targetId: "base-hook", disable: true }),
    ])
  })

  it("reports invalid override syntax without producing hooks or overrides", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - override: 123
    event: session.created
    actions:
      - command: invalid-target
  - override: base-hook
    disable: nope
    event: session.idle
    actions:
      - command: invalid-disable
`,
    )

    expect(result.hooks.size).toBe(0)
    expect(result.overrides).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_override", path: "hooks[0].override" }),
      expect.objectContaining({ code: "invalid_override", path: "hooks[1].disable" }),
    ])
  })

  it("parses async: true into HookConfig for non-before events", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: file.changed
    async: true
    actions:
      - bash: "git commit"
  - event: tool.after.write
    async: true
    actions:
      - bash: "echo done"
  - event: session.idle
    actions:
      - bash: "echo sync"
`,
    )

    expect(result.errors).toEqual([])
    expect(result.hooks.get("file.changed")?.[0]?.async).toBe(true)
    expect(result.hooks.get("tool.after.write")?.[0]?.async).toBe(true)
    expect(result.hooks.get("session.idle")?.[0]?.async).toBeUndefined()
  })

  it("rejects async: true on tool.before events", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: tool.before.*
    async: true
    actions:
      - bash: "echo blocked"
  - event: tool.before.write
    async: true
    actions:
      - bash: "echo blocked"
`,
    )

    expect(Array.from(result.hooks.values()).flat()).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_async", path: "hooks[0].async" }),
      expect.objectContaining({ code: "invalid_async", path: "hooks[1].async" }),
    ])
  })

  it("rejects non-boolean async values", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: file.changed
    async: "yes"
    actions:
      - bash: "echo bad"
`,
    )

    expect(Array.from(result.hooks.values()).flat()).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_async", path: "hooks[0].async" }),
    ])
  })

  it("rejects async: true on session.idle events", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: session.idle
    async: true
    actions:
      - bash: "echo idle"
`,
    )

    expect(Array.from(result.hooks.values()).flat()).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_async", path: "hooks[0].async" }),
    ])
  })

  it("rejects async: true with command or tool actions", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: file.changed
    async: true
    actions:
      - command: "review-pr"
  - event: tool.after.write
    async: true
    actions:
      - tool:
          name: write
          args:
            filePath: test.txt
`,
    )

    expect(Array.from(result.hooks.values()).flat()).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "invalid_async", path: "hooks[0].async" }),
      expect.objectContaining({ code: "invalid_async", path: "hooks[1].async" }),
    ])
  })

  it("allows async: true with only bash actions", () => {
    const result = parseHooksFile(
      "/repo/.opencode/hook/hooks.yaml",
      `hooks:
  - event: file.changed
    async: true
    actions:
      - bash: "git add ."
      - bash: "git commit -m 'auto'"
`,
    )

    expect(result.errors).toEqual([])
    expect(result.hooks.get("file.changed")?.[0]?.async).toBe(true)
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

  it("updates snapshot signatures when override files change", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    let projectFile = `hooks:
  - override: base-hook
    event: session.created
    actions:
      - command: replacement-one
`

    const readSnapshot = () => loadDiscoveredHooksSnapshot({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => filePath === globalPath || filePath === projectPath,
      readFile: (filePath) => {
        if (filePath === globalPath) {
          return `hooks:
  - id: base-hook
    event: session.created
    actions:
      - command: base
`
        }

        return projectFile
      },
    })

    const first = readSnapshot()
    const second = readSnapshot()
    projectFile = `hooks:
  - override: base-hook
    event: session.created
    actions:
      - command: replacement-two
`
    const third = readSnapshot()

    expect(first.signature).toBe(second.signature)
    expect(third.signature).not.toBe(first.signature)
  })

  it("uses one coherent read per discovered file when building snapshots", () => {
    const projectDir = "/repo/project"
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    let readCount = 0

    const result = loadDiscoveredHooksSnapshot({
      projectDir,
      exists: (filePath) => filePath === projectPath,
      readFile: () => {
        readCount += 1
        return readCount === 1
          ? `hooks:
  - event: session.created
    actions:
      - command: first
`
          : `hooks:
  - event: session.created
    actions:
      - command: second
`
      },
    })

    expect(readCount).toBe(1)
    expect(result.signature).toContain("first")
    expect(result.signature).not.toContain("second")
    expect(result.hooks.get("session.created")?.map((hook) => hook.actions[0])).toEqual([{ command: "first" }])
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

  it("applies later-file overrides before appending later regular hooks", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    const files = new Map([
      [globalPath, `hooks:
  - id: global-first
    event: session.idle
    actions:
      - command: global-first
  - id: global-second
    event: session.idle
    actions:
      - command: global-second
`],
      [projectPath, `hooks:
  - override: global-first
    event: session.idle
    actions:
      - command: project-replacement
  - override: global-second
    disable: true
  - event: session.idle
    actions:
      - command: project-appended
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? "",
    })

    expect(result.errors).toEqual([])
    expect(result.hooks.get("session.idle")?.map((hook) => hook.actions[0])).toEqual([
      { command: "project-replacement" },
      { command: "project-appended" },
    ])
  })

  it("disables only the targeted hook and leaves unrelated hooks in order", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    const files = new Map([
      [globalPath, `hooks:
  - id: global-first
    event: session.idle
    actions:
      - command: global-first
  - id: global-second
    event: session.idle
    actions:
      - command: global-second
  - id: global-third
    event: session.idle
    actions:
      - command: global-third
`],
      [projectPath, `hooks:
  - override: global-second
    disable: true
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? "",
    })

    expect(result.errors).toEqual([])
    expect(result.hooks.get("session.idle")?.map((hook) => hook.actions[0])).toEqual([
      { command: "global-first" },
      { command: "global-third" },
    ])
    expect(result.hooks.get("session.idle")?.map((hook) => hook.id)).toEqual(["global-first", "global-third"])
  })

  it("preserves replacement ids so later overrides can target them", () => {
    const homeDir = "/home/tester"
    const projectDir = "/repo/project"
    const globalPath = path.join(homeDir, ".config", "opencode", "hook", "hooks.yaml")
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")
    const files = new Map([
      [globalPath, `hooks:
  - id: base-hook
    event: session.created
    actions:
      - command: base
  - event: session.created
    actions:
      - command: untouched
`],
      [projectPath, `hooks:
  - id: replacement-hook
    override: base-hook
    event: session.created
    actions:
      - command: replacement
  - override: replacement-hook
    event: session.created
    actions:
      - command: replacement-twice
`],
    ])

    const result = loadDiscoveredHooks({
      projectDir,
      homeDir,
      platform: "linux",
      exists: (filePath) => files.has(filePath),
      readFile: (filePath) => files.get(filePath) ?? "",
    })

    expect(result.errors).toEqual([])
    expect(result.hooks.get("session.created")).toEqual([
      expect.objectContaining({ actions: [{ command: "replacement-twice" }] }),
      expect.objectContaining({ actions: [{ command: "untouched" }] }),
    ])
  })

  it("reports missing override targets from later discovered files", () => {
    const projectDir = "/repo/project"
    const projectPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")

    const result = loadDiscoveredHooks({
      projectDir,
      exists: (filePath) => filePath === projectPath,
      readFile: () => `hooks:
  - override: missing-hook
    disable: true
`,
    })

    expect(result.hooks.size).toBe(0)
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "override_target_not_found",
        filePath: projectPath,
        path: "hooks[0].override",
      }),
    ])
  })
})
