import { spawn } from "node:child_process"

import {
  DEFAULT_BASH_TIMEOUT,
  type BashExecutionRequest,
  type BashHookContext,
  type BashHookResult,
  type BashProcessResult,
} from "./bash-types.js"

const TIMEOUT_EXIT_CODE = 1
const BLOCKING_EXIT_CODE = 2
const KILL_GRACE_PERIOD_MS = 250

export async function executeBashHook(request: BashExecutionRequest): Promise<BashHookResult> {
  const processResult = await executeBashProcess(request)

  return mapBashProcessResultToHookResult(processResult, request.context)
}

export function mapBashProcessResultToHookResult(result: BashProcessResult, context: BashHookContext): BashHookResult {
  if (result.timedOut) {
    return { ...result, status: "timed_out", blocking: false }
  }

  if (result.exitCode === 0) {
    return { ...result, status: "success", blocking: false }
  }

  if (result.exitCode === BLOCKING_EXIT_CODE && isBlockingToolBeforeEvent(context.event)) {
    return { ...result, status: "blocked", blocking: true }
  }

  return { ...result, status: "failed", blocking: false }
}

export function isBlockingToolBeforeEvent(event: string): boolean {
  return event.startsWith("tool.before.")
}

async function executeBashProcess(request: BashExecutionRequest): Promise<BashProcessResult> {
  const timeout = request.timeout ?? DEFAULT_BASH_TIMEOUT
  const startTime = Date.now()

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      OPENCODE_PROJECT_DIR: request.projectDir,
      OPENCODE_SESSION_ID: request.context.session_id,
    }

    const child = spawn("bash", ["-c", request.command], {
      cwd: request.context.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const finalize = (result: Omit<BashProcessResult, "durationMs">): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer) {
        clearTimeout(killTimer)
      }

      resolve({
        ...result,
        durationMs: Date.now() - startTime,
      })
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        child.kill("SIGKILL")
      }, KILL_GRACE_PERIOD_MS)
    }, timeout)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(request.context))

    child.on("error", (error) => {
      finalize({
        command: request.command,
        stdout,
        stderr: appendStderr(stderr, error.message),
        exitCode: TIMEOUT_EXIT_CODE,
        signal: null,
        timedOut: false,
      })
    })

    child.on("close", (code, signal) => {
      const exitCode = timedOut ? TIMEOUT_EXIT_CODE : (code ?? TIMEOUT_EXIT_CODE)
      const timeoutMessage = timedOut ? `Command timed out after ${timeout}ms` : undefined

      finalize({
        command: request.command,
        stdout,
        stderr: appendStderr(stderr, timeoutMessage),
        exitCode,
        signal,
        timedOut,
      })
    })
  })
}

function appendStderr(stderr: string, message?: string): string {
  if (!message) {
    return stderr
  }

  if (!stderr) {
    return message
  }

  return `${stderr}${stderr.endsWith("\n") ? "" : "\n"}${message}`
}
