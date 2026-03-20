import { extname } from "node:path"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { executeBashHook } from "./bash-executor.js"
import type { BashExecutionRequest } from "./bash-types.js"
import { loadDiscoveredHooks } from "./load-hooks.js"
import { SessionStateStore } from "./session-state.js"
import { getToolAffectedPaths } from "./tool-paths.js"
import type { HookAction, HookConfig, HookEvent, HookMap } from "./types.js"

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".java",
  ".py",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".kt",
  ".kts",
  ".swift",
  ".m",
  ".mm",
  ".cs",
  ".fs",
  ".scala",
  ".clj",
  ".hs",
  ".lua",
])

interface ToolExecuteBeforeInput {
  readonly tool: string
  readonly sessionID?: string
  readonly callID: string
}

interface ToolExecuteBeforeOutput {
  readonly args?: Record<string, unknown>
}

interface ToolExecuteAfterInput {
  readonly tool: string
  readonly sessionID?: string
  readonly callID: string
  readonly args?: Record<string, unknown>
}

interface RuntimeEventEnvelope {
  readonly event: {
    readonly type: string
    readonly properties?: Record<string, unknown>
  }
}

interface RuntimeActionContext {
  readonly files?: readonly string[]
  readonly toolName?: string
  readonly toolArgs?: Record<string, unknown>
}

interface HookExecutionResult {
  readonly blocked: boolean
  readonly blockReason?: string
}

type ExecuteBashHook = (request: BashExecutionRequest) => ReturnType<typeof executeBashHook>

export interface CreateHooksRuntimeOptions {
  readonly hooks?: HookMap
  readonly executeBash?: ExecuteBashHook
}

export function createHooksRuntime(input: PluginInput, options: CreateHooksRuntimeOptions = {}): Hooks {
  const loaded = options.hooks ? { hooks: options.hooks, errors: [] } : loadDiscoveredHooks({ projectDir: input.directory })
  if (loaded.errors.length > 0) {
    throw new Error(formatHookLoadErrors(loaded.errors))
  }

  const hooks = loaded.hooks
  const state = new SessionStateStore()
  const runBashHook = options.executeBash ?? executeBashHook

  return {
    "tool.execute.before": async (eventInput: ToolExecuteBeforeInput, eventOutput: ToolExecuteBeforeOutput): Promise<void> => {
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const toolArgs = eventOutput.args ?? {}
      state.setPendingToolCall(eventInput.callID, sessionID, toolArgs)

      const result = await dispatchToolHooks(
        hooks,
        state,
        input,
        runBashHook,
        "before",
        eventInput.tool,
        sessionID,
        {
          toolName: eventInput.tool,
          toolArgs,
        },
      )

      if (result.blocked) {
        state.consumePendingToolCall(eventInput.callID)
        throw new Error(result.blockReason ?? "Blocked by hook")
      }
    },

    "tool.execute.after": async (eventInput: ToolExecuteAfterInput, _eventOutput?: unknown): Promise<void> => {
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const pending = state.consumePendingToolCall(eventInput.callID)
      const toolArgs = pending?.toolArgs ?? {}

      state.addModifiedPaths(sessionID, getToolAffectedPaths(eventInput.tool, toolArgs))

      await dispatchToolHooks(
        hooks,
        state,
        input,
        runBashHook,
        "after",
        eventInput.tool,
        sessionID,
        {
          toolName: eventInput.tool,
          toolArgs,
        },
      )
    },

    event: async ({ event }: RuntimeEventEnvelope): Promise<void> => {
      const properties = event.properties ?? {}

      if (event.type === "session.created") {
        const info = asRecord(properties.info)
        const sessionID = pickString(info?.id)
        if (!sessionID) {
          return
        }

        state.rememberSession(sessionID, pickString(info?.parentID) ?? null)
        await dispatchHooks(hooks, state, input, runBashHook, "session.created", sessionID)
        return
      }

      if (event.type === "session.deleted") {
        const info = asRecord(properties.info)
        const sessionID = pickString(info?.id)
        if (!sessionID) {
          return
        }

        await dispatchHooks(hooks, state, input, runBashHook, "session.deleted", sessionID)
        state.deleteSession(sessionID)
        return
      }

      if (event.type === "session.idle") {
        const sessionID = pickString(properties.sessionID)
        if (!sessionID) {
          return
        }

        const files = state.consumeModifiedPaths(sessionID)
        await dispatchHooks(hooks, state, input, runBashHook, "session.idle", sessionID, { files })
      }
    },
  }
}

async function dispatchToolHooks(
  hooks: HookMap,
  state: SessionStateStore,
  input: PluginInput,
  runBashHook: ExecuteBashHook,
  phase: "before" | "after",
  toolName: string,
  sessionID: string,
  context: RuntimeActionContext,
): Promise<HookExecutionResult> {
  const wildcardResult = await dispatchHooks(
    hooks,
    state,
    input,
    runBashHook,
    `tool.${phase}.*`,
    sessionID,
    context,
    { canBlock: phase === "before" },
  )
  if (wildcardResult.blocked) {
    return wildcardResult
  }

  return dispatchHooks(
    hooks,
    state,
    input,
    runBashHook,
    `tool.${phase}.${toolName}`,
    sessionID,
    context,
    { canBlock: phase === "before" },
  )
}

async function dispatchHooks(
  hooks: HookMap,
  state: SessionStateStore,
  input: PluginInput,
  runBashHook: ExecuteBashHook,
  event: HookEvent,
  sessionID: string,
  context: RuntimeActionContext = {},
  options: { canBlock?: boolean } = {},
): Promise<HookExecutionResult> {
  const eventHooks = hooks.get(event)
  if (!eventHooks || eventHooks.length === 0) {
    return { blocked: false }
  }

  for (const hook of eventHooks) {
    const result = await executeHook(hook, state, input, runBashHook, sessionID, context, options)
    if (result.blocked) {
      return result
    }
  }

  return { blocked: false }
}

async function executeHook(
  hook: HookConfig,
  state: SessionStateStore,
  input: PluginInput,
  runBashHook: ExecuteBashHook,
  sessionID: string,
  context: RuntimeActionContext,
  options: { canBlock?: boolean },
): Promise<HookExecutionResult> {
  if (!(await shouldRunHook(hook, state, input, sessionID, context))) {
    return { blocked: false }
  }

  for (const action of hook.actions) {
    const result = await executeAction(action, input, runBashHook, hook.event, sessionID, context)
    if (result.blocked && options.canBlock) {
      return result
    }
  }

  return { blocked: false }
}

async function shouldRunHook(
  hook: HookConfig,
  state: SessionStateStore,
  input: PluginInput,
  sessionID: string,
  context: RuntimeActionContext,
): Promise<boolean> {
  for (const condition of hook.conditions ?? []) {
    if (condition === "isMainSession") {
      const isMainSession = await state.isMainSession(sessionID, async (targetSessionID) => {
        const response = await input.client.session.get({ path: { id: targetSessionID } })
        return pickString(asRecord(response.data)?.parentID) ?? null
      })

      if (!isMainSession) {
        return false
      }
    }

    if (condition === "hasCodeChange") {
      if (!(context.files ?? []).some(hasCodeExtension)) {
        return false
      }
    }
  }

  return true
}

async function executeAction(
  action: HookAction,
  input: PluginInput,
  runBashHook: ExecuteBashHook,
  event: HookEvent,
  sessionID: string,
  context: RuntimeActionContext,
): Promise<HookExecutionResult> {
  if ("command" in action) {
    const config = typeof action.command === "string" ? { name: action.command, args: "" } : action.command
    await input.client.session.command({
      path: { id: sessionID },
      body: {
        command: config.name,
        arguments: config.args ?? "",
      },
      query: { directory: input.directory },
    })
    return { blocked: false }
  }

  if ("tool" in action) {
    await input.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [
          {
            type: "text",
            text: `Use the ${action.tool.name} tool with these arguments: ${JSON.stringify(action.tool.args ?? {})}`,
          },
        ],
      },
      query: { directory: input.directory },
    })
    return { blocked: false }
  }

  const config = typeof action.bash === "string" ? { command: action.bash } : action.bash
  const result = await runBashHook({
    command: config.command,
    timeout: config.timeout,
    projectDir: input.directory,
    context: {
      session_id: sessionID,
      event,
      cwd: input.directory,
      files: context.files,
      tool_name: context.toolName,
      tool_args: context.toolArgs,
    },
  })

  if (result.blocking) {
    return { blocked: true, blockReason: result.stderr.trim() || "Blocked by hook" }
  }

  return { blocked: false }
}

function hasCodeExtension(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return Boolean(extension && CODE_EXTENSIONS.has(extension))
}

function formatHookLoadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `Failed to load hooks:\n${details.join("\n")}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}
