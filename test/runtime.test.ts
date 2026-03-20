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
  it("dispatches wildcard then specific tool hooks and reuses pending args by callID", async () => {
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
    await runtime["tool.execute.after"]?.({ tool: "write", sessionID: "session-1", callID: "call-2" }, {})

    expect(bashEvents.map(({ event }) => event)).toEqual([
      "tool.before.*",
      "tool.before.write",
      "tool.before.*",
      "tool.before.write",
      "tool.after.*",
      "tool.after.write",
    ])
    expect(bashEvents[bashEvents.length - 2]?.toolArgs).toEqual({ filePath: "src/two.ts", value: "two" })
    expect(bashEvents[bashEvents.length - 1]?.toolArgs).toEqual({ filePath: "src/two.ts", value: "two" })
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
    await runtime["tool.execute.after"]?.({ tool: "multiedit", sessionID: "session-1", callID: "call-doc" }, {})
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
    await runtime["tool.execute.after"]?.({ tool: "apply_patch", sessionID: "session-1", callID: "call-code" }, {})
    await runtime.event?.({ event: { type: "session.idle", properties: { sessionID: "session-1" } } } as never)

    expect(idleContexts).toEqual([["src/runtime.ts", "docs/notes.md"]])
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
