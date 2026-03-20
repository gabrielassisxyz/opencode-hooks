import os from "node:os"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

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
        "node -e 'let input=\"\";process.stdin.on(\"data\",chunk=>input+=chunk);process.stdin.on(\"end\",()=>{const context=JSON.parse(input);process.stdout.write(JSON.stringify({projectDir:process.env.OPENCODE_PROJECT_DIR,worktreeDir:process.env.OPENCODE_WORKTREE_DIR,sessionId:process.env.OPENCODE_SESSION_ID,event:context.event}));process.stderr.write(context.tool_name ?? \"missing\")})'",
      context: baseContext,
      projectDir: "/repo/project",
    })

    expect(result.status).toBe("success")
    expect(result.blocking).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("write")
    expect(JSON.parse(result.stdout)).toEqual({
      projectDir: "/repo/project",
      worktreeDir: expect.any(String),
      sessionId: "session-123",
      event: "tool.before.write",
    })
  })

  it("runs bash hooks with bash-compatible shell semantics", async () => {
    const result = await executeBashHook({
      command: "if [[ -n \"ok\" ]]; then echo {1..3}; fi",
      context: baseContext,
      projectDir: "/repo/project",
    })

    expect(result.status).toBe("success")
    expect(result.stdout.trim()).toBe("1 2 3")
  })

  it("enforces the default timeout when no timeout is provided", async () => {
    expect(DEFAULT_BASH_TIMEOUT).toBe(60_000)
  })

  it("marks timed out processes as non-blocking failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Bash hook timed_out"))
    errorSpy.mockRestore()
  })

  it("logs non-blocking bash failures with command details", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await executeBashHook({
      command: "printf 'broken' >&2; exit 1",
      context: baseContext,
      projectDir: "/repo/project",
    })

    expect(result.status).toBe("failed")
    expect(result.blocking).toBe(false)
    expect(result.stderr).toBe("broken")
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('command="printf \'broken\' >&2; exit 1"'))
    errorSpy.mockRestore()
  })

  it("redacts and truncates bash failure logs by default", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const secret = "super-secret-token-value"
    const longOutput = "x".repeat(600)

    await executeBashHook({
      command: `printf 'token=${secret}\n${longOutput}' >&2; exit 1`,
      context: baseContext,
      projectDir: "/repo/project",
    })

    const logged = errorSpy.mock.calls[0]?.[0]
    expect(logged).toContain("token=[REDACTED]")
    expect(logged).toContain("[truncated")
    expect(logged).not.toContain(secret)
    errorSpy.mockRestore()
  })

  it("redacts quoted and JSON-style secrets in bash failure logs", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const token = "json-token-secret"
    const password = "quoted-password-secret"

    await executeBashHook({
      command:
        `node -e "process.stderr.write(JSON.stringify({token:\"${token}\",nested:{password:\"${password}\"}}) + ' password=\\\"${password}\\\"'); process.exit(1)"`,
      context: baseContext,
      projectDir: "/repo/project",
    })

    const logged = errorSpy.mock.calls[0]?.[0]
    expect(logged).toContain('\"token\":\"[REDACTED]\"')
    expect(logged).toContain('\"password\":\"[REDACTED]\"')
    expect(logged).toContain('password=\\\"[REDACTED]\\\"')
    expect(logged).not.toContain(token)
    expect(logged).not.toContain(password)
    errorSpy.mockRestore()
  })

  it("uses worktree-aware env for git repositories", async () => {
    const repoDir = process.cwd()
    const projectDir = path.join(repoDir, "src")
    const result = await executeBashHook({
      command:
        "node -e 'process.stdout.write(JSON.stringify({projectDir:process.env.OPENCODE_PROJECT_DIR,worktreeDir:process.env.OPENCODE_WORKTREE_DIR,gitCommonDir:process.env.OPENCODE_GIT_COMMON_DIR}))'",
      context: {
        ...baseContext,
        cwd: projectDir,
      },
      projectDir,
    })

    expect(result.status).toBe("success")
    expect(JSON.parse(result.stdout)).toEqual({
      projectDir,
      worktreeDir: repoDir,
      gitCommonDir: expect.any(String),
    })
  })

  it("reports spawn failures as non-blocking failed hooks", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const missingDir = path.join(os.tmpdir(), `opencode-hooks-missing-${Date.now()}`)

    const result = await executeBashHook({
      command: "pwd",
      context: {
        ...baseContext,
        cwd: missingDir,
      },
      projectDir: missingDir,
    })

    expect(result.status).toBe("failed")
    expect(result.blocking).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("ENOENT")
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Bash hook failed"))
    errorSpy.mockRestore()
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
