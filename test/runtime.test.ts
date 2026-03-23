import { mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { createHooksRuntime } from "../src/core/runtime.ts"
import type { HookConfig, HookEvent, HookMap } from "../src/core/types.ts"

function createMockPluginInput() {
  const command = vi.fn(async () => ({ data: {}, response: { status: 200 } }))
  const prompt = vi.fn(async () => ({ data: {}, response: { status: 200 } }))
  const get = vi.fn(async () => ({ data: {} }))

  return {
    input: {
      directory: "/repo/project",
      client: {
        session: {
          command,
          prompt,
          get,
        },
      },
    },
    command,
    prompt,
    get,
  }
}

function createHook(
  event: HookEvent,
  config: Omit<HookConfig, "event" | "scope" | "runIn"> & Partial<Pick<HookConfig, "scope" | "runIn">>,
): HookConfig {
  return {
    event,
    scope: "all",
    runIn: "current",
    ...config,
  }
}

describe("createHooksRuntime", () => {
  it("dispatches wildcard then specific tool hooks and prefers after-event args over cached before args", async () => {
    const { input } = createMockPluginInput()
    const bashEvents: Array<{ event: string; toolArgs?: Record<string, unknown> }> = []
    const executeBash = vi.fn(async ({ context }) => {
      bashEvents.push({ event: context.event, toolArgs: context.tool_args })
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      ["tool.before.*", [createHook("tool.before.*", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
      [["tool.before.write" as const][0], [createHook("tool.before.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 1 } })]],
      ["tool.after.*", [createHook("tool.after.*", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 2 } })]],
      [["tool.after.write" as const][0], [createHook("tool.after.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 3 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-1" },
      { args: { filePath: "src/one.ts", value: "one" } },
    )
    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-2" },
      { args: { filePath: "src/two.ts", value: "two" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-2", args: { filePath: "src/two-final.ts", value: "two-final" } },
      { title: "", output: "", metadata: {} },
    )

    expect(bashEvents.map(({ event }) => event)).toEqual([
      "tool.before.*",
      "tool.before.write",
      "tool.before.*",
      "tool.before.write",
      "tool.after.*",
      "tool.after.write",
    ])
    expect(bashEvents[bashEvents.length - 2]?.toolArgs).toEqual({ filePath: "src/two-final.ts", value: "two-final" })
    expect(bashEvents[bashEvents.length - 1]?.toolArgs).toEqual({ filePath: "src/two-final.ts", value: "two-final" })
  })

  it("tracks modified paths for mutation tools and only runs session.idle hooks when code changed", async () => {
    const { input } = createMockPluginInput()
    const idleContexts: Array<{ files?: readonly string[]; changes?: readonly unknown[] }> = []
    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "session.idle") {
        idleContexts.push({ files: context.files, changes: context.changes })
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "session.idle",
        [
          createHook("session.idle", {
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "multiedit", sessionID: "session-1", callID: "call-doc" },
      { args: { filePath: "README.md" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "multiedit", sessionID: "session-1", callID: "call-doc", args: {} },
      { title: "", output: "", metadata: {} },
    )
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(idleContexts).toEqual([])

    await runtime["tool.execute.before"]?.(
      { tool: "apply_patch", sessionID: "session-1", callID: "call-code" },
      {
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: schema/query.graphql",
            "@@",
            "-old",
            "+new",
            "*** Add File: docs/notes.md",
            "+note",
            "*** End Patch",
          ].join("\n"),
        },
      },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "apply_patch", sessionID: "session-1", callID: "call-code", args: {} },
      { title: "", output: "", metadata: {} },
    )
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(idleContexts).toEqual([
      {
        files: ["schema/query.graphql", "docs/notes.md"],
        changes: [
          { operation: "modify", path: "schema/query.graphql" },
          { operation: "create", path: "docs/notes.md" },
        ],
      },
    ])
  })

  it("dispatches file.changed with structured changes and preserves patch hook aliases", async () => {
    const { input } = createMockPluginInput()
    const observedEvents: Array<{ event: string; files?: readonly string[]; changes?: readonly unknown[] }> = []
    const executeBash = vi.fn(async ({ context }) => {
      observedEvents.push({ event: context.event, files: context.files, changes: context.changes })

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
      [["tool.after.patch" as const][0], [createHook("tool.after.patch", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 1 } })]],
      [["tool.after.apply_patch" as const][0], [createHook("tool.after.apply_patch", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 2 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "patch", sessionID: "session-1", callID: "call-patch" },
      {
        args: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/write.ts",
            "@@",
            "-old",
            "+new",
            "*** Delete File: src/old.ts",
            "*** Update File: src/rename-me.ts",
            "*** Move to: src/renamed.ts",
            "@@",
            "-before rename",
            "+after rename",
            "*** Add File: src/new.ts",
            "+new file",
            "*** End Patch",
          ].join("\n"),
        },
      },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "patch", sessionID: "session-1", callID: "call-patch", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(observedEvents).toEqual([
      {
        event: "file.changed",
        files: ["src/write.ts", "src/old.ts", "src/rename-me.ts", "src/renamed.ts", "src/new.ts"],
        changes: [
          { operation: "modify", path: "src/write.ts" },
          { operation: "delete", path: "src/old.ts" },
          { operation: "rename", fromPath: "src/rename-me.ts", toPath: "src/renamed.ts" },
          { operation: "create", path: "src/new.ts" },
        ],
      },
      {
        event: "tool.after.patch",
        files: ["src/write.ts", "src/old.ts", "src/rename-me.ts", "src/renamed.ts", "src/new.ts"],
        changes: [
          { operation: "modify", path: "src/write.ts" },
          { operation: "delete", path: "src/old.ts" },
          { operation: "rename", fromPath: "src/rename-me.ts", toPath: "src/renamed.ts" },
          { operation: "create", path: "src/new.ts" },
        ],
      },
      {
        event: "tool.after.apply_patch",
        files: ["src/write.ts", "src/old.ts", "src/rename-me.ts", "src/renamed.ts", "src/new.ts"],
        changes: [
          { operation: "modify", path: "src/write.ts" },
          { operation: "delete", path: "src/old.ts" },
          { operation: "rename", fromPath: "src/rename-me.ts", toPath: "src/renamed.ts" },
          { operation: "create", path: "src/new.ts" },
        ],
      },
    ])
  })

  it("normalizes apply_patch diff payloads for file.changed and session.idle", async () => {
    const { input } = createMockPluginInput()
    const observedEvents: Array<{ event: string; files?: readonly string[]; changes?: readonly unknown[] }> = []
    const executeBash = vi.fn(async ({ context }) => {
      observedEvents.push({ event: context.event, files: context.files, changes: context.changes })

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
      [
        "session.idle",
        [
          createHook("session.idle", {
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 1 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "apply_patch", sessionID: "session-1", callID: "call-diff" },
      {
        args: {
          diff: [
            "*** Begin Patch",
            "*** Add File: src/generated.ts",
            "+export const generated = true",
            "*** Update File: src/existing.ts",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
          ].join("\n"),
        },
      },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "apply_patch", sessionID: "session-1", callID: "call-diff", args: {} },
      { title: "", output: "", metadata: {} },
    )
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(observedEvents).toEqual([
      {
        event: "file.changed",
        files: ["src/generated.ts", "src/existing.ts"],
        changes: [
          { operation: "create", path: "src/generated.ts" },
          { operation: "modify", path: "src/existing.ts" },
        ],
      },
      {
        event: "session.idle",
        files: ["src/generated.ts", "src/existing.ts"],
        changes: [
          { operation: "create", path: "src/generated.ts" },
          { operation: "modify", path: "src/existing.ts" },
        ],
      },
    ])
  })

  it("tracks write, edit, multiedit, and apply_patch paths for session.idle and clears them after dispatch", async () => {
    const { input } = createMockPluginInput()
    const idleContexts: Array<readonly string[] | undefined> = []
    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "session.idle") {
        idleContexts.push(context.files)
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "session.idle",
        [
          createHook("session.idle", {
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    const mutationCalls = [
      { tool: "write", callID: "call-write", args: { filePath: "src/write.ts", value: "one" } },
      { tool: "edit", callID: "call-edit", args: { filePath: "src/edit.ts", oldString: "old", newString: "new" } },
      { tool: "multiedit", callID: "call-multiedit", args: { filePath: "src/edit.ts", edits: [] } },
      {
        tool: "apply_patch",
        callID: "call-patch",
        args: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/write.ts",
            "@@",
            "-old",
            "+new",
            "*** Delete File: src/old.ts",
            "*** Update File: src/rename-me.ts",
            "*** Move to: src/renamed.ts",
            "@@",
            "-before rename",
            "+after rename",
            "*** Add File: src/new.ts",
            "+new file",
            "*** End Patch",
          ].join("\n"),
        },
      },
    ]

    for (const call of mutationCalls) {
      await runtime["tool.execute.before"]?.(
        { tool: call.tool, sessionID: "session-1", callID: call.callID },
        { args: call.args },
      )
      await runtime["tool.execute.after"]?.(
        { tool: call.tool, sessionID: "session-1", callID: call.callID, args: {} },
        { title: "", output: "", metadata: {} },
      )
    }

    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(idleContexts).toEqual([["src/write.ts", "src/edit.ts", "src/old.ts", "src/rename-me.ts", "src/renamed.ts", "src/new.ts"]])
  })

  it("retains modified paths when session.idle dispatch fails and clears them after a later success", async () => {
    const { input } = createMockPluginInput()
    const idleContexts: Array<readonly string[] | undefined> = []
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    let shouldFailIdle = true
    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "session.idle") {
        idleContexts.push(context.files)
        if (shouldFailIdle) {
          shouldFailIdle = false
          throw new Error("idle failed")
        }
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "session.idle",
        [
          createHook("session.idle", {
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-write" },
      { args: { filePath: "src/retry.ts", value: "retry" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-write", args: {} },
      { title: "", output: "", metadata: {} },
    )

    await expect(runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)).rejects.toThrow(
      "idle failed",
    )
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(idleContexts).toEqual([["src/retry.ts"], ["src/retry.ts"]])
    errorSpy.mockRestore()
  })

  it("retains changes added while session.idle hooks are still dispatching", async () => {
    const { input } = createMockPluginInput()
    const idleContexts: Array<readonly string[] | undefined> = []
    let runtime: ReturnType<typeof createHooksRuntime>
    let injectedChange = false

    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "session.idle") {
        idleContexts.push(context.files)

        if (!injectedChange) {
          injectedChange = true
          await runtime["tool.execute.before"]?.(
            { tool: "write", sessionID: "session-1", callID: "call-during-idle" },
            { args: { filePath: "src/during-idle.ts", value: "during idle" } },
          )
          await runtime["tool.execute.after"]?.(
            { tool: "write", sessionID: "session-1", callID: "call-during-idle", args: {} },
            { title: "", output: "", metadata: {} },
          )
        }
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "session.idle",
        [
          createHook("session.idle", {
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial" },
      { args: { filePath: "src/initial.ts", value: "initial" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial", args: {} },
      { title: "", output: "", metadata: {} },
    )

    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(idleContexts).toEqual([["src/initial.ts"], ["src/during-idle.ts"]])
  })

  it("queues reentrant file.changed redispatches instead of dropping them", async () => {
    const { input } = createMockPluginInput()
    const observedFiles: Array<readonly string[] | undefined> = []
    let runtime: ReturnType<typeof createHooksRuntime>
    let injectedChange = false

    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "file.changed") {
        observedFiles.push(context.files)

        if (!injectedChange) {
          injectedChange = true
          await runtime["tool.execute.before"]?.(
            { tool: "write", sessionID: "session-1", callID: "call-during-file-changed" },
            { args: { filePath: "src/queued.ts", value: "queued" } },
          )
          await runtime["tool.execute.after"]?.(
            { tool: "write", sessionID: "session-1", callID: "call-during-file-changed", args: {} },
            { title: "", output: "", metadata: {} },
          )
        }
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial" },
      { args: { filePath: "src/initial.ts", value: "initial" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(observedFiles).toEqual([["src/initial.ts"], ["src/queued.ts"]])
  })

  it("queues reentrant tool.after redispatches with their own tool args", async () => {
    const { input } = createMockPluginInput()
    const observedAfterContexts: Array<{ files?: readonly string[]; toolArgs?: Record<string, unknown> }> = []
    let runtime: ReturnType<typeof createHooksRuntime>
    let injectedChange = false

    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "tool.after.write") {
        observedAfterContexts.push({ files: context.files, toolArgs: context.tool_args })

        if (!injectedChange) {
          injectedChange = true
          await runtime["tool.execute.before"]?.(
            { tool: "write", sessionID: "session-1", callID: "call-during-tool-after" },
            { args: { filePath: "src/queued-after.ts", value: "queued-after" } },
          )
          await runtime["tool.execute.after"]?.(
            {
              tool: "write",
              sessionID: "session-1",
              callID: "call-during-tool-after",
              args: { filePath: "src/queued-after-final.ts", value: "queued-after-final" },
            },
            { title: "", output: "", metadata: {} },
          )
        }
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["tool.after.write" as const][0], [createHook("tool.after.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial" },
      { args: { filePath: "src/initial-after.ts", value: "initial-after" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(observedAfterContexts).toEqual([
      { files: ["src/initial-after.ts"], toolArgs: { filePath: "src/initial-after.ts", value: "initial-after" } },
      { files: ["src/queued-after-final.ts"], toolArgs: { filePath: "src/queued-after-final.ts", value: "queued-after-final" } },
    ])
  })

  it("replays repeated reentrant file.changed events even when payloads are identical", async () => {
    const { input } = createMockPluginInput()
    const observedFiles: Array<readonly string[] | undefined> = []
    let runtime: ReturnType<typeof createHooksRuntime>
    let replayCount = 0

    const executeBash = vi.fn(async ({ context }) => {
      if (context.event === "file.changed") {
        observedFiles.push(context.files)

        if (replayCount < 2) {
          replayCount += 1
          await runtime["tool.execute.before"]?.(
            { tool: "write", sessionID: "session-1", callID: `call-repeat-${replayCount}` },
            { args: { filePath: "src/repeated.ts", value: "same" } },
          )
          await runtime["tool.execute.after"]?.(
            { tool: "write", sessionID: "session-1", callID: `call-repeat-${replayCount}`, args: {} },
            { title: "", output: "", metadata: {} },
          )
        }
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial-repeat" },
      { args: { filePath: "src/repeated.ts", value: "same" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-initial-repeat", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(observedFiles).toEqual([["src/repeated.ts"], ["src/repeated.ts"], ["src/repeated.ts"]])
  })

  it("blocks tool.before execution when a hook returns exit code 2", async () => {
    const { input } = createMockPluginInput()
    const executeBash = vi.fn(async ({ context }) => ({
      command: "hook",
      stdout: "",
      stderr: `blocked:${context.event}`,
      durationMs: 1,
      exitCode: 2,
      signal: null,
      timedOut: false,
      status: "blocked" as const,
      blocking: true,
    }))

    const hooks: HookMap = new Map([
      ["tool.before.*", [createHook("tool.before.*", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
      [["tool.after.write" as const][0], [createHook("tool.after.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 1 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await expect(
      runtime["tool.execute.before"]?.(
        { tool: "write", sessionID: "session-1", callID: "blocked-call" },
        { args: { filePath: "src/blocked.ts", value: "blocked" } },
      ),
    ).rejects.toThrow("blocked:tool.before.*")

    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "blocked-call", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(executeBash).toHaveBeenCalledTimes(2)
    expect(executeBash.mock.calls.map(([request]) => request.context.event)).toEqual([
      "tool.before.*",
      "tool.after.write",
    ])
    expect(executeBash.mock.calls[1]?.[0].context.tool_args).toEqual({})
  })

  it("serializes overlapping blocking tool.before hooks instead of bypassing queued enforcement", async () => {
    const { input } = createMockPluginInput()
    let runtime: ReturnType<typeof createHooksRuntime>
    let invocationCount = 0
    let nestedBeforePromise: Promise<void> | undefined

    const executeBash = vi.fn(async ({ context }) => {
      if (context.event !== "tool.before.write") {
        return {
          command: "hook",
          stdout: "",
          stderr: "",
          durationMs: 1,
          exitCode: 0,
          signal: null,
          timedOut: false,
          status: "success" as const,
          blocking: false,
        }
      }

      invocationCount += 1

      if (invocationCount === 1) {
        nestedBeforePromise = runtime["tool.execute.before"]?.(
          { tool: "write", sessionID: "session-1", callID: "call-nested" },
          { args: { filePath: "src/nested.ts", value: "nested" } },
        )

        await Promise.resolve()

        return {
          command: "hook",
          stdout: "",
          stderr: "",
          durationMs: 1,
          exitCode: 0,
          signal: null,
          timedOut: false,
          status: "success" as const,
          blocking: false,
        }
      }

      return {
        command: "hook",
        stdout: "",
        stderr: "blocked:nested-before",
        durationMs: 1,
        exitCode: 2,
        signal: null,
        timedOut: false,
        status: "blocked" as const,
        blocking: true,
      }
    })

    const hooks: HookMap = new Map([
      [["tool.before.write" as const][0], [createHook("tool.before.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await expect(
      runtime["tool.execute.before"]?.(
        { tool: "write", sessionID: "session-1", callID: "call-initial" },
        { args: { filePath: "src/initial.ts", value: "initial" } },
      ),
    ).resolves.toBeUndefined()

    await expect(nestedBeforePromise).rejects.toThrow("blocked:nested-before")
    expect(invocationCount).toBe(2)
  })

  it("does not block tools when command actions or scope lookups fail", async () => {
    const { input, command, get } = createMockPluginInput()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    command.mockRejectedValueOnce(new Error("command failed"))
    get.mockRejectedValueOnce(new Error("lookup failed"))

    const bashEvents: string[] = []
    const executeBash = vi.fn(async ({ context }) => {
      bashEvents.push(context.event)
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "tool.before.*",
        [
          createHook("tool.before.*", {
            actions: [{ command: "review-pr" }, { bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
          createHook("tool.before.*", {
            scope: "main",
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 1 },
          }),
        ],
      ],
      [["tool.after.write" as const][0], [createHook("tool.after.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 2 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await expect(
      runtime["tool.execute.before"]?.(
        { tool: "write", sessionID: "session-1", callID: "call-1" },
        { args: { filePath: "src/file.ts", value: "content" } },
      ),
    ).resolves.toBeUndefined()

    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(bashEvents).toEqual(["tool.before.*", "tool.after.write"])
    expect(get).toHaveBeenCalledWith({ path: { id: "session-1" } })
    errorSpy.mockRestore()
  })

  it("evaluates main and child scope from the root session state", async () => {
    const { input, get } = createMockPluginInput()
    const triggeredEvents: string[] = []
    const executeBash = vi.fn(async ({ context }) => {
      triggeredEvents.push(`${context.event}:${context.session_id}`)
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "session.created",
        [
          createHook("session.created", {
            scope: "main",
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
          createHook("session.created", {
            scope: "child",
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 1 },
          }),
        ],
      ],
      [
        "session.deleted",
        [
          createHook("session.deleted", {
            scope: "main",
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 2 },
          }),
          createHook("session.deleted", {
            scope: "child",
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 3 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "grandchild-session", parentID: "child-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "child-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "grandchild-session" } } } } as never)

    expect(triggeredEvents).toEqual([
      "session.created:main-session",
      "session.created:child-session",
      "session.created:grandchild-session",
      "session.deleted:main-session",
      "session.deleted:child-session",
      "session.deleted:grandchild-session",
    ])
    expect(get).not.toHaveBeenCalled()
  })

  it("re-resolves the true root session when descendants are seen before parents", async () => {
    const { input, command } = createMockPluginInput()
    const hooks: HookMap = new Map([
      [
        "tool.after.write",
        [
          createHook("tool.after.write", {
            scope: "child",
            runIn: "main",
            actions: [{ command: { name: "review-pr", args: "--out-of-order" } }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "grandchild-session", parentID: "child-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "grandchild-session", callID: "call-out-of-order-root" },
      { args: { filePath: "src/file.ts", value: "content" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "grandchild-session", callID: "call-out-of-order-root", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(command).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: { command: "review-pr", arguments: "--out-of-order" },
      query: { directory: "/repo/project" },
    })
  })

  it("routes command and tool actions to the root session when runIn is main", async () => {
    const { input, command, prompt } = createMockPluginInput()
    const hooks: HookMap = new Map([
      [
        "tool.after.write",
        [
          createHook("tool.after.write", {
            runIn: "main",
            actions: [{ command: { name: "review-pr", args: "--summary" } }, { tool: { name: "bash", args: { command: "pwd" } } }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-route" },
      { args: { filePath: "src/file.ts", value: "content" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-route", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(command).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: { command: "review-pr", arguments: "--summary" },
      query: { directory: "/repo/project" },
    })
    expect(prompt).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: {
        parts: [
          {
            type: "text",
            text: "Use the bash tool with these arguments: {\"command\":\"pwd\"}",
          },
        ],
      },
      query: { directory: "/repo/project" },
    })
  })

  it("logs runIn main resolution failures inside action handling without aborting dispatch", async () => {
    const { input, get } = createMockPluginInput()
    get.mockRejectedValueOnce(new Error("root lookup failed"))

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const bashEvents: string[] = []
    const executeBash = vi.fn(async ({ context }) => {
      bashEvents.push(context.event)
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [
        "tool.after.write",
        [
          createHook("tool.after.write", {
            runIn: "main",
            actions: [{ command: { name: "review-pr", args: "--summary" } }, { bash: "hook" }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-resolution-failure" },
      { args: { filePath: "src/file.ts", value: "content" } },
    )

    await expect(
      runtime["tool.execute.after"]?.(
        { tool: "write", sessionID: "child-session", callID: "call-resolution-failure", args: {} },
        { title: "", output: "", metadata: {} },
      ),
    ).resolves.toBeUndefined()

    expect(bashEvents).toEqual(["tool.after.write"])
    expect(errorSpy).toHaveBeenCalledWith("[opencode-hooks] tool.after.write hook from a failed: root lookup failed")
    errorSpy.mockRestore()
  })

  it("allows parallel runIn main command and tool actions without skipping independent dispatches", async () => {
    const { input, command, prompt } = createMockPluginInput()
    let releaseActions: (() => void) | undefined
    const actionsReleased = new Promise<void>((resolve) => {
      releaseActions = resolve
    })

    command.mockImplementation(async () => {
      await actionsReleased
      return { data: {}, response: { status: 200 } }
    })
    prompt.mockImplementation(async () => {
      await actionsReleased
      return { data: {}, response: { status: 200 } }
    })

    const hooks: HookMap = new Map([
      [
        "tool.after.write",
        [
          createHook("tool.after.write", {
            runIn: "main",
            actions: [{ command: { name: "review-pr", args: "--parallel" } }, { tool: { name: "bash", args: { command: "pwd" } } }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-a", parentID: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-b", parentID: "main-session" } } } } as never)

    await Promise.all([
      runtime["tool.execute.before"]?.(
        { tool: "write", sessionID: "child-a", callID: "call-parallel-a" },
        { args: { filePath: "src/a.ts", value: "a" } },
      ),
      runtime["tool.execute.before"]?.(
        { tool: "write", sessionID: "child-b", callID: "call-parallel-b" },
        { args: { filePath: "src/b.ts", value: "b" } },
      ),
    ])

    const afterPromises = [
      runtime["tool.execute.after"]?.(
        { tool: "write", sessionID: "child-a", callID: "call-parallel-a", args: {} },
        { title: "", output: "", metadata: {} },
      ),
      runtime["tool.execute.after"]?.(
        { tool: "write", sessionID: "child-b", callID: "call-parallel-b", args: {} },
        { title: "", output: "", metadata: {} },
      ),
    ]

    await Promise.resolve()
    releaseActions?.()
    await Promise.all(afterPromises)

    expect(command).toHaveBeenCalledTimes(2)
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(command.mock.calls.map((call) => ((call as unknown[])[0] as { path: { id: string } } | undefined)?.path.id)).toEqual(["main-session", "main-session"])
    expect(prompt.mock.calls.map((call) => ((call as unknown[])[0] as { path: { id: string } } | undefined)?.path.id)).toEqual(["main-session", "main-session"])
  })

  it("keeps current-session routing for command and tool actions when runIn is omitted", async () => {
    const { input, command, prompt } = createMockPluginInput()
    const hooks: HookMap = new Map([
      [
        "tool.after.write",
        [
          createHook("tool.after.write", {
            actions: [{ command: { name: "review-pr", args: "--child" } }, { tool: { name: "bash", args: { command: "pwd" } } }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-current" },
      { args: { filePath: "src/file.ts", value: "content" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-current", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(command).toHaveBeenCalledWith({
      path: { id: "child-session" },
      body: { command: "review-pr", arguments: "--child" },
      query: { directory: "/repo/project" },
    })
    expect(prompt).toHaveBeenCalledWith({
      path: { id: "child-session" },
      body: {
        parts: [
          {
            type: "text",
            text: "Use the bash tool with these arguments: {\"command\":\"pwd\"}",
          },
        ],
      },
      query: { directory: "/repo/project" },
    })
  })

  it("cleans pending tool calls when a session is deleted before tool.execute.after", async () => {
    const { input } = createMockPluginInput()
    const observedContexts: Array<{ event: string; toolArgs?: Record<string, unknown>; files?: readonly string[] }> = []
    const executeBash = vi.fn(async ({ context }) => {
      observedContexts.push({ event: context.event, toolArgs: context.tool_args, files: context.files })
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["tool.after.write" as const][0], [createHook("tool.after.write", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
      [["file.changed" as const][0], [createHook("file.changed", { actions: [{ bash: "hook" }], source: { filePath: "a", index: 1 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-cleanup" },
      { args: { filePath: "src/pending.ts", value: "pending" } },
    )
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "session-1" } } } } as never)
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-cleanup", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(observedContexts).toEqual([
      { event: "tool.after.write", toolArgs: {}, files: undefined },
    ])
  })

  it("skips actions targeting deleted sessions and bounds reentrant main routing", async () => {
    const { input, command, prompt } = createMockPluginInput()
    const hooks: HookMap = new Map([
      [
        "session.deleted",
        [
          createHook("session.deleted", {
            actions: [{ command: "review-pr" }, { tool: { name: "bash", args: { command: "pwd" } } }],
            source: { filePath: "a", index: 0 },
          }),
          createHook("session.deleted", {
            runIn: "main",
            scope: "child",
            actions: [{ command: "review-pr" }, { tool: { name: "bash", args: { command: "pwd" } } }],
            source: { filePath: "a", index: 1 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "main-session" } } } } as never)

    expect(command).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: { command: "review-pr", arguments: "" },
      query: { directory: "/repo/project" },
    })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: {
        parts: [
          {
            type: "text",
            text: "Use the bash tool with these arguments: {\"command\":\"pwd\"}",
          },
        ],
      },
      query: { directory: "/repo/project" },
    })
  })

  it("continues with valid discovered hooks when hooks.yaml contains invalid entries", async () => {
    const projectDir = path.join(os.tmpdir(), `opencode-hooks-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(path.join(projectDir, ".opencode", "hook"), { recursive: true })
    writeFileSync(
      path.join(projectDir, ".opencode", "hook", "hooks.yaml"),
      `hooks:
  - event: nope
    actions:
      - bash: invalid
  - event: session.created
    actions:
      - bash: hook
`,
      "utf8",
    )

    const { input } = createMockPluginInput()
    const executeBash = vi.fn(async () => ({
      command: "hook",
      stdout: "",
      stderr: "",
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      status: "success" as const,
      blocking: false,
    }))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const runtime = createHooksRuntime({ ...(input as object), directory: projectDir } as never, { executeBash })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-1" } } } } as never)

    expect(executeBash).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("continuing with valid hooks"))
    errorSpy.mockRestore()
  })

  it("reloads hooks.yaml before new events after a valid edit", async () => {
    const projectDir = path.join(os.tmpdir(), `opencode-hooks-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(path.join(projectDir, ".opencode", "hook"), { recursive: true })

    const writeHooks = (commandName: string) => {
      writeFileSync(
        path.join(projectDir, ".opencode", "hook", "hooks.yaml"),
        `hooks:
  - event: session.created
    actions:
      - bash: ${commandName}
`,
        "utf8",
      )
    }

    writeHooks("first")

    const { input } = createMockPluginInput()
    const executeBash = vi.fn(async ({ command }) => ({
      command,
      stdout: "",
      stderr: "",
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      status: "success" as const,
      blocking: false,
    }))

    const runtime = createHooksRuntime({ ...(input as object), directory: projectDir } as never, { executeBash })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-1" } } } } as never)

    writeHooks("second")

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-2" } } } } as never)

    expect(executeBash.mock.calls.map(([request]) => request.command)).toEqual(["first", "second"])
  })

  it("keeps the last known good hooks when a reload edit is invalid and logs the validation error once", async () => {
    const projectDir = path.join(os.tmpdir(), `opencode-hooks-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(path.join(projectDir, ".opencode", "hook"), { recursive: true })
    const hooksPath = path.join(projectDir, ".opencode", "hook", "hooks.yaml")

    const { input } = createMockPluginInput()
    const executeBash = vi.fn(async ({ command }) => ({
      command,
      stdout: "",
      stderr: "",
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      status: "success" as const,
      blocking: false,
    }))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    writeFileSync(
      hooksPath,
      `hooks:
  - event: session.created
    actions:
      - bash: valid
`,
      "utf8",
    )

    const runtime = createHooksRuntime({ ...(input as object), directory: projectDir } as never, { executeBash })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-1" } } } } as never)

    writeFileSync(
      hooksPath,
      `hooks:
  - event: session.created
    actions: invalid
`,
      "utf8",
    )

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-2" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-3" } } } } as never)

    writeFileSync(
      hooksPath,
      `hooks:
  - event: session.created
    actions:
      - bash: fixed
`,
      "utf8",
    )

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "session-4" } } } } as never)

    expect(executeBash.mock.calls.map(([request]) => request.command)).toEqual(["valid", "valid", "valid", "fixed"])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("keeping last known good hooks"))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("actions must be a non-empty array"))
    errorSpy.mockRestore()
  })

  it("keeps the action cwd for runIn main command and tool actions", async () => {
    const { input, command, prompt } = createMockPluginInput()
    const directory = path.join(process.cwd(), "src", "core")
    const hooks: HookMap = new Map([
      [
        "tool.after.write",
        [
          createHook("tool.after.write", {
            runIn: "main",
            actions: [{ command: { name: "review-pr", args: "--summary" } }, { tool: { name: "bash", args: { command: "pwd" } } }],
            source: { filePath: "a", index: 0 },
          }),
        ],
      ],
    ])

    const runtime = createHooksRuntime({ ...(input as object), directory } as never, { hooks })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-route" },
      { args: { filePath: "src/file.ts", value: "content" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "child-session", callID: "call-route", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(command).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: { command: "review-pr", arguments: "--summary" },
      query: { directory },
    })
    expect(prompt).toHaveBeenCalledWith({
      path: { id: "main-session" },
      body: {
        parts: [
          {
            type: "text",
            text: "Use the bash tool with these arguments: {\"command\":\"pwd\"}",
          },
        ],
      },
      query: { directory },
    })
  })

  it("async hooks return before action completes and serialize per event+session", async () => {
    const { input } = createMockPluginInput()
    const executionOrder: string[] = []
    let resolveFirst: () => void
    const firstBlocked = new Promise<void>((resolve) => { resolveFirst = resolve })

    const executeBash = vi.fn(async ({ context }) => {
      const label = `${context.event}:${context.tool_args?.filePath}`
      executionOrder.push(`start:${label}`)

      if (label === "file.changed:src/first.ts") {
        await firstBlocked
      }

      executionOrder.push(`end:${label}`)
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { async: true, actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-1" },
      { args: { filePath: "src/first.ts", value: "first" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-1", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(executionOrder).toEqual(["start:file.changed:src/first.ts"])

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-2" },
      { args: { filePath: "src/second.ts", value: "second" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-2", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(executionOrder).toEqual(["start:file.changed:src/first.ts"])

    resolveFirst!()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(executionOrder).toEqual([
      "start:file.changed:src/first.ts",
      "end:file.changed:src/first.ts",
      "start:file.changed:src/second.ts",
      "end:file.changed:src/second.ts",
    ])
  })

  it("async hook errors are caught and logged, not thrown", async () => {
    const { input } = createMockPluginInput()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const executeBash = vi.fn(async () => {
      throw new Error("async hook exploded")
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { async: true, actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-err" },
      { args: { filePath: "src/error.ts", value: "error" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-err", args: {} },
      { title: "", output: "", metadata: {} },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("async hook exploded"),
    )
    errorSpy.mockRestore()
  })

  it("async hook with multiple actions preserves sequential order", async () => {
    const { input } = createMockPluginInput()
    const actionOrder: string[] = []

    const executeBash = vi.fn(async ({ context }) => {
      actionOrder.push(context.event)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", {
        async: true,
        actions: [{ bash: "action-1" }, { bash: "action-2" }, { bash: "action-3" }],
        source: { filePath: "a", index: 0 },
      })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-seq" },
      { args: { filePath: "src/seq.ts", value: "seq" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-seq", args: {} },
      { title: "", output: "", metadata: {} },
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(executeBash).toHaveBeenCalledTimes(3)
    expect(actionOrder).toEqual(["file.changed", "file.changed", "file.changed"])
  })

  it("sync and async hooks on the same event work correctly together", async () => {
    const { input } = createMockPluginInput()
    const executionOrder: string[] = []
    let callIndex = 0

    const executeBash = vi.fn(async ({ context }) => {
      const index = callIndex++
      if (index === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      executionOrder.push(`${context.event}:${context.tool_args?.filePath}`)
      return {
        command: "hook",
        stdout: "",
        stderr: "",
        durationMs: 1,
        exitCode: 0,
        signal: null,
        timedOut: false,
        status: "success" as const,
        blocking: false,
      }
    })

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [
        createHook("file.changed", { actions: [{ bash: "sync-hook" }], source: { filePath: "a", index: 0 } }),
        createHook("file.changed", { async: true, actions: [{ bash: "async-hook" }], source: { filePath: "a", index: 1 } }),
      ]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-mix" },
      { args: { filePath: "src/mix.ts", value: "mix" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-mix", args: {} },
      { title: "", output: "", metadata: {} },
    )

    expect(executionOrder).toEqual(["file.changed:src/mix.ts"])

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(executionOrder).toEqual([
      "file.changed:src/mix.ts",
      "file.changed:src/mix.ts",
    ])
    expect(executeBash).toHaveBeenCalledTimes(2)
  })

  it("async queue cleans up after completion", async () => {
    const { input } = createMockPluginInput()

    const executeBash = vi.fn(async () => ({
      command: "hook",
      stdout: "",
      stderr: "",
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      status: "success" as const,
      blocking: false,
    }))

    const hooks: HookMap = new Map([
      [["file.changed" as const][0], [createHook("file.changed", { async: true, actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } })]],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-cleanup" },
      { args: { filePath: "src/cleanup.ts", value: "cleanup" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-cleanup", args: {} },
      { title: "", output: "", metadata: {} },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(executeBash).toHaveBeenCalledTimes(1)

    await runtime["tool.execute.before"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-cleanup-2" },
      { args: { filePath: "src/cleanup2.ts", value: "cleanup2" } },
    )
    await runtime["tool.execute.after"]?.(
      { tool: "write", sessionID: "session-1", callID: "call-cleanup-2", args: {} },
      { title: "", output: "", metadata: {} },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(executeBash).toHaveBeenCalledTimes(2)
  })
})
