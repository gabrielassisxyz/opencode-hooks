import os from "node:os"

import { describe, expect, it } from "vitest"

import { executeBashHook, mapBashProcessResultToHookResult } from "../src/core/bash-executor.ts"
import { DEFAULT_BASH_TIMEOUT, type BashHookContext, type BashProcessResult } from "../src/core/bash-types.ts"

const baseContext: BashHookContext = {
  session_id: "session-123",
  event: "tool.before.write",
  cwd: os.tmpdir(),
  tool_name: "write",
  tool_args: { filePath: "src/index.ts" },
}

describe("executeBashHook", () => {
  it("captures stdout/stderr and injects env plus stdin context", async () => {
    const result = await executeBashHook({
      command:
        "node -e 'let input=\"\";process.stdin.on(\"data\",chunk=>input+=chunk);process.stdin.on(\"end\",()=>{const context=JSON.parse(input);process.stdout.write(JSON.stringify({projectDir:process.env.OPENCODE_PROJECT_DIR,sessionId:process.env.OPENCODE_SESSION_ID,event:context.event}));process.stderr.write(context.tool_name ?? \"missing\")})'",
      context: baseContext,
      projectDir: "/repo/project",
    })

    expect(result.status).toBe("success")
    expect(result.blocking).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("write")
    expect(JSON.parse(result.stdout)).toEqual({
      projectDir: "/repo/project",
      sessionId: "session-123",
      event: "tool.before.write",
    })
  })

  it("enforces the default timeout when no timeout is provided", async () => {
    expect(DEFAULT_BASH_TIMEOUT).toBe(60_000)
  })

  it("marks timed out processes as non-blocking failures", async () => {
    const result = await executeBashHook({
      command: "sleep 1",
      context: baseContext,
      projectDir: "/repo/project",
      timeout: 50,
    })

    expect(result.status).toBe("timed_out")
    expect(result.blocking).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Command timed out after 50ms")
  })
})

describe("mapBashProcessResultToHookResult", () => {
  const processResult: BashProcessResult = {
    command: "exit 2",
    stdout: "",
    stderr: "blocked",
    durationMs: 10,
    exitCode: 2,
    signal: null,
    timedOut: false,
  }

  it("surfaces exit code 2 as blocking for tool.before hooks", () => {
    const result = mapBashProcessResultToHookResult(processResult, baseContext)

    expect(result.status).toBe("blocked")
    expect(result.blocking).toBe(true)
  })

  it("treats exit code 2 as non-blocking outside tool.before hooks", () => {
    const result = mapBashProcessResultToHookResult(processResult, {
      ...baseContext,
      event: "tool.after.write",
    })

    expect(result.status).toBe("failed")
    expect(result.blocking).toBe(false)
  })
})
