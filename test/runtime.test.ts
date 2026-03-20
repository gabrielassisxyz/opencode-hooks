import { describe, expect, it, vi } from "vitest"

import { createHooksRuntime } from "../src/core/runtime.ts"
import type { HookMap } from "../src/core/types.ts"

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
      ["tool.before.*", [{ event: "tool.before.*", actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } }]],
      [["tool.before.write" as const][0], [{ event: "tool.before.write", actions: [{ bash: "hook" }], source: { filePath: "a", index: 1 } }]],
      ["tool.after.*", [{ event: "tool.after.*", actions: [{ bash: "hook" }], source: { filePath: "a", index: 2 } }]],
      [["tool.after.write" as const][0], [{ event: "tool.after.write", actions: [{ bash: "hook" }], source: { filePath: "a", index: 3 } }]],
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
          {
            event: "session.idle",
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          },
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
            "*** Update File: src/runtime.ts",
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

    expect(idleContexts).toEqual([["src/runtime.ts", "docs/notes.md"]])
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
          {
            event: "session.idle",
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          },
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

    expect(idleContexts).toEqual([["src/write.ts", "src/edit.ts", "src/old.ts", "src/new.ts"]])
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
          {
            event: "session.idle",
            conditions: ["hasCodeChange"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          },
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
      ["tool.before.*", [{ event: "tool.before.*", actions: [{ bash: "hook" }], source: { filePath: "a", index: 0 } }]],
      [["tool.after.write" as const][0], [{ event: "tool.after.write", actions: [{ bash: "hook" }], source: { filePath: "a", index: 1 } }]],
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

  it("does not block tools when command actions or isMainSession lookups fail", async () => {
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
          {
            event: "tool.before.*",
            actions: [{ command: "review-pr" }, { bash: "hook" }],
            source: { filePath: "a", index: 0 },
          },
          {
            event: "tool.before.*",
            conditions: ["isMainSession"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 1 },
          },
        ],
      ],
      [["tool.after.write" as const][0], [{ event: "tool.after.write", actions: [{ bash: "hook" }], source: { filePath: "a", index: 2 } }]],
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

  it("evaluates isMainSession from session state seeded by lifecycle events", async () => {
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
          {
            event: "session.created",
            conditions: ["isMainSession"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 0 },
          },
        ],
      ],
      [
        "session.deleted",
        [
          {
            event: "session.deleted",
            conditions: ["isMainSession"],
            actions: [{ bash: "hook" }],
            source: { filePath: "a", index: 1 },
          },
        ],
      ],
    ])

    const runtime = createHooksRuntime(input as never, { hooks, executeBash })

    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "main-session" } } } } as never)
    await runtime.event?.({ event: { type: "session.deleted", properties: { info: { id: "child-session" } } } } as never)

    expect(triggeredEvents).toEqual([
      "session.created:main-session",
      "session.deleted:main-session",
    ])
    expect(get).not.toHaveBeenCalled()
  })
})
