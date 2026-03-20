import { extname } from "node:path"

import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { executeBashHook } from "./bash-executor.js"
import type { BashExecutionRequest } from "./bash-types.js"
import { loadDiscoveredHooksSnapshot } from "./load-hooks.js"
import { SessionStateStore } from "./session-state.js"
import { getChangedPaths, getMutationToolHookNames, getToolFileChanges } from "./tool-paths.js"
import type { FileChange, HookAction, HookConfig, HookEvent, HookMap, HookRunIn, HookValidationError } from "./types.js"

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".json5",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".astro",
  ".mdx",
  ".graphql",
  ".gql",
  ".proto",
  ".sql",
  ".prisma",
  ".go",
  ".rs",
  ".zig",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".java",
  ".groovy",
  ".gradle",
  ".py",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".psd1",
  ".bat",
  ".cmd",
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
  ".dart",
  ".elm",
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".nim",
  ".nix",
  ".r",
  ".rkt",
  ".tf",
  ".tfvars",
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
  readonly changes?: readonly FileChange[]
  readonly toolName?: string
  readonly toolArgs?: Record<string, unknown>
  readonly sourceSessionID?: string
  readonly targetSessionID?: string
}

interface HookExecutionResult {
  readonly blocked: boolean
  readonly blockReason?: string
}

interface DispatchState {
  active: boolean
  currentSignature?: string
  pending: DispatchRequest[]
  pendingSignatures: Set<string>
}

interface DispatchRequest {
  readonly context: RuntimeActionContext
  readonly options: { canBlock?: boolean }
  readonly signature: string
}

type ExecuteBashHook = (request: BashExecutionRequest) => ReturnType<typeof executeBashHook>

export interface CreateHooksRuntimeOptions {
  readonly hooks?: HookMap
  readonly executeBash?: ExecuteBashHook
}

export function createHooksRuntime(input: PluginInput, options: CreateHooksRuntimeOptions = {}): Hooks {
  let loaded = options.hooks
    ? { hooks: options.hooks, errors: [] as HookValidationError[], signature: "manual" }
    : loadDiscoveredHooksSnapshot({ projectDir: input.directory })
  if (loaded.errors.length > 0) {
    console.error(formatHookLoadErrors(loaded.errors))
  }

  let hooks = loaded.hooks
  let lastLoadedSignature = loaded.signature
  let lastReportedInvalidSignature = loaded.errors.length > 0 ? loaded.signature : undefined
  const state = new SessionStateStore()
  const runBashHook = options.executeBash ?? executeBashHook
  const dispatchStates = new Map<string, DispatchState>()
  const activeActionTargets = new Set<string>()

  function refreshHooks(): HookMap {
    if (options.hooks) {
      return hooks
    }

    const nextLoaded = loadDiscoveredHooksSnapshot({ projectDir: input.directory })
    if (nextLoaded.signature === lastLoadedSignature) {
      return hooks
    }

    lastLoadedSignature = nextLoaded.signature
    if (nextLoaded.errors.length > 0) {
      if (lastReportedInvalidSignature !== nextLoaded.signature) {
        console.error(formatHookReloadErrors(nextLoaded.errors))
        lastReportedInvalidSignature = nextLoaded.signature
      }
      return hooks
    }

    hooks = nextLoaded.hooks
    lastReportedInvalidSignature = undefined
    return hooks
  }

  return {
    "tool.execute.before": async (eventInput: ToolExecuteBeforeInput, eventOutput: ToolExecuteBeforeOutput): Promise<void> => {
      const activeHooks = refreshHooks()
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const toolArgs = eventOutput.args ?? {}
      state.setPendingToolCall(eventInput.callID, sessionID, toolArgs)

      const result = await dispatchToolHooks(
        activeHooks,
        state,
        input,
        runBashHook,
        dispatchStates,
        activeActionTargets,
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
      const activeHooks = refreshHooks()
      const sessionID = eventInput.sessionID
      if (!sessionID) {
        return
      }

      const pending = state.consumePendingToolCall(eventInput.callID)
      const toolArgs = resolveToolArgs(eventInput.args, pending?.toolArgs)
      const changes = getToolFileChanges(eventInput.tool, toolArgs)
      const files = changes.length > 0 ? getChangedPaths(changes) : undefined

      state.addFileChanges(sessionID, changes)

      if (changes.length > 0) {
        await dispatchHooks(activeHooks, state, input, runBashHook, "file.changed", sessionID, {
          files,
          changes,
          toolName: eventInput.tool,
          toolArgs,
        }, {}, dispatchStates, activeActionTargets)
      }

      await dispatchToolHooks(
        activeHooks,
        state,
        input,
        runBashHook,
        dispatchStates,
        activeActionTargets,
        "after",
        eventInput.tool,
        sessionID,
        {
          files,
          changes,
          toolName: eventInput.tool,
          toolArgs,
        },
      )
    },

    event: async ({ event }: RuntimeEventEnvelope): Promise<void> => {
      const activeHooks = refreshHooks()
      const properties = event.properties ?? {}

      if (event.type === "session.created") {
        const info = asRecord(properties.info)
        const sessionID = pickString(info?.id)
        if (!sessionID) {
          return
        }

        state.rememberSession(sessionID, pickString(info?.parentID) ?? null)
        await dispatchHooks(activeHooks, state, input, runBashHook, "session.created", sessionID, {}, {}, dispatchStates, activeActionTargets)
        return
      }

      if (event.type === "session.deleted") {
        const info = asRecord(properties.info)
        const sessionID = pickString(info?.id)
        if (!sessionID) {
          return
        }
        
        state.rememberSession(sessionID, pickString(info?.parentID) ?? undefined)
        state.deleteSession(sessionID)
        await dispatchHooks(activeHooks, state, input, runBashHook, "session.deleted", sessionID, {}, {}, dispatchStates, activeActionTargets)
        return
      }

      if (event.type === "session.idle") {
        const sessionID = pickString(properties.sessionID)
        if (!sessionID) {
          return
        }

        const changes = state.getFileChanges(sessionID)
        const files = state.getModifiedPaths(sessionID)
        state.beginIdleDispatch(sessionID, changes)

        try {
          await dispatchHooks(activeHooks, state, input, runBashHook, "session.idle", sessionID, { files, changes }, {}, dispatchStates, activeActionTargets)
          state.consumeFileChanges(sessionID, changes)
        } catch (error) {
          state.cancelIdleDispatch(sessionID)
          throw error
        }
      }
    },
  }
}

async function dispatchToolHooks(
  hooks: HookMap,
  state: SessionStateStore,
  input: PluginInput,
  runBashHook: ExecuteBashHook,
  dispatchStates: Map<string, DispatchState>,
  activeActionTargets: Set<string>,
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
    dispatchStates,
    activeActionTargets,
  )
  if (wildcardResult.blocked) {
    return wildcardResult
  }

  for (const resolvedToolName of getMutationToolHookNames(toolName).length > 0 ? getMutationToolHookNames(toolName) : [toolName]) {
    const result = await dispatchHooks(
      hooks,
      state,
      input,
      runBashHook,
      `tool.${phase}.${resolvedToolName}`,
      sessionID,
      context,
      { canBlock: phase === "before" },
      dispatchStates,
      activeActionTargets,
    )

    if (result.blocked) {
      return result
    }
  }

  return { blocked: false }
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
  dispatchStates: Map<string, DispatchState>,
  activeActionTargets: Set<string>,
): Promise<HookExecutionResult> {
  const eventHooks = hooks.get(event)
  if (!eventHooks || eventHooks.length === 0) {
    return { blocked: false }
  }

  const dispatchKey = `${event}:${sessionID}`
  const dispatchState = dispatchStates.get(dispatchKey)
  if (dispatchState?.active) {
    const signature = serializeDispatchRequest(context, options)
    if (signature !== dispatchState.currentSignature && !dispatchState.pendingSignatures.has(signature)) {
      dispatchState.pending.push({ context, options, signature })
      dispatchState.pendingSignatures.add(signature)
    }
    return { blocked: false }
  }

  const currentState = dispatchState ?? { active: false, pending: [], pendingSignatures: new Set<string>() }
  currentState.active = true
  dispatchStates.set(dispatchKey, currentState)

  try {
    const queue: DispatchRequest[] = [{ context, options, signature: serializeDispatchRequest(context, options) }]

    while (queue.length > 0) {
      const request = queue.shift()!
      currentState.currentSignature = request.signature

      for (const hook of eventHooks) {
        const result = await executeHook(hook, state, input, runBashHook, sessionID, request.context, request.options, activeActionTargets)
        if (result.blocked) {
          return result
        }
      }

      if (currentState.pending.length > 0) {
        queue.push(...currentState.pending)
        currentState.pending = []
        currentState.pendingSignatures.clear()
      }
    }

    return { blocked: false }
  } finally {
    currentState.active = false
    currentState.currentSignature = undefined
    currentState.pending = []
    currentState.pendingSignatures.clear()
    dispatchStates.delete(dispatchKey)
  }
}

async function executeHook(
  hook: HookConfig,
  state: SessionStateStore,
  input: PluginInput,
  runBashHook: ExecuteBashHook,
  sessionID: string,
  context: RuntimeActionContext,
  options: { canBlock?: boolean },
  activeActionTargets: Set<string>,
): Promise<HookExecutionResult> {
  try {
    if (!(await shouldRunHook(hook, state, input, sessionID, context))) {
      return { blocked: false }
    }
  } catch (error) {
    logHookFailure(hook.event, hook.source.filePath, error)
    return { blocked: false }
  }

  for (const action of hook.actions) {
      const result = await executeAction(
        action,
        hook.runIn,
        input,
        state,
        runBashHook,
        hook.event,
        sessionID,
        context,
        hook.source.filePath,
        activeActionTargets,
      )
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
  if (!(await state.evaluateScope(sessionID, hook.scope, (currentSessionID) => resolveParentSessionID(input, currentSessionID)))) {
    return false
  }

  for (const condition of hook.conditions ?? []) {
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
  runIn: HookRunIn,
  input: PluginInput,
  state: SessionStateStore,
  runBashHook: ExecuteBashHook,
  event: HookEvent,
  sessionID: string,
  context: RuntimeActionContext,
  sourceFilePath: string,
  activeActionTargets: Set<string>,
): Promise<HookExecutionResult> {
  const targetSessionID = await resolveActionSessionID(state, input, sessionID, runIn)
  const actionContext: RuntimeActionContext = { ...context, sourceSessionID: sessionID, targetSessionID }
  const executionDirectory = input.directory

  if ("command" in action) {
    if (!targetSessionID) {
      return { blocked: false }
    }

    const actionKey = `${event}:${targetSessionID}:command:${sourceFilePath}:${JSON.stringify(action.command)}`
    if (activeActionTargets.has(actionKey)) {
      return { blocked: false }
    }

    activeActionTargets.add(actionKey)

    try {
      const config = typeof action.command === "string" ? { name: action.command, args: "" } : action.command
      await input.client.session.command({
        path: { id: targetSessionID },
        body: {
          command: config.name,
          arguments: config.args ?? "",
        },
        query: { directory: executionDirectory },
      })
    } catch (error) {
      logHookFailure(event, sourceFilePath, error)
    } finally {
      activeActionTargets.delete(actionKey)
    }

    return { blocked: false }
  }

  if ("tool" in action) {
    if (!targetSessionID) {
      return { blocked: false }
    }

    const actionKey = `${event}:${targetSessionID}:tool:${sourceFilePath}:${JSON.stringify(action.tool)}`
    if (activeActionTargets.has(actionKey)) {
      return { blocked: false }
    }

    activeActionTargets.add(actionKey)

    try {
      await input.client.session.prompt({
        path: { id: targetSessionID },
        body: {
          parts: [
            {
              type: "text",
              text: `Use the ${action.tool.name} tool with these arguments: ${JSON.stringify(action.tool.args ?? {})}`,
            },
          ],
        },
        query: { directory: executionDirectory },
      })
    } catch (error) {
      logHookFailure(event, sourceFilePath, error)
    } finally {
      activeActionTargets.delete(actionKey)
    }

    return { blocked: false }
  }

  const config = typeof action.bash === "string" ? { command: action.bash } : action.bash
  const result = await runBashHook({
    command: config.command,
    timeout: config.timeout,
    projectDir: executionDirectory,
    context: {
      session_id: sessionID,
      event,
      cwd: executionDirectory,
      files: actionContext.files,
      changes: actionContext.changes,
      tool_name: actionContext.toolName,
      tool_args: actionContext.toolArgs,
    },
  })

  if (result.blocking) {
    return { blocked: true, blockReason: result.stderr.trim() || "Blocked by hook" }
  }

  return { blocked: false }
}

async function resolveActionSessionID(
  state: SessionStateStore,
  input: PluginInput,
  sessionID: string,
  runIn: HookRunIn,
): Promise<string | undefined> {
  const targetSessionID =
    runIn === "main" ? await state.getRootSessionID(sessionID, (currentSessionID) => resolveParentSessionID(input, currentSessionID)) : sessionID

  return state.isDeleted(targetSessionID) ? undefined : targetSessionID
}

async function resolveParentSessionID(input: PluginInput, sessionID: string): Promise<string | null> {
  const response = await input.client.session.get({ path: { id: sessionID } })
  const data = asRecord(response.data)
  const info = asRecord(data?.info)
  return pickString(info?.parentID) ?? pickString(data?.parentID) ?? null
}

function hasCodeExtension(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return Boolean(extension && CODE_EXTENSIONS.has(extension))
}

function formatHookLoadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `[opencode-hooks] Failed to load some hooks; continuing with valid hooks:\n${details.join("\n")}`
}

function formatHookReloadErrors(errors: Array<{ filePath: string; message: string; path?: string }>): string {
  const details = errors.map((error) => `${error.filePath}${error.path ? `#${error.path}` : ""}: ${error.message}`)
  return `[opencode-hooks] Failed to reload hooks.yaml; keeping last known good hooks:\n${details.join("\n")}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function resolveToolArgs(
  eventArgs: Record<string, unknown> | undefined,
  pendingArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (eventArgs && Object.keys(eventArgs).length > 0) {
    return eventArgs
  }

  return pendingArgs ?? eventArgs ?? {}
}

function serializeDispatchRequest(context: RuntimeActionContext, options: { canBlock?: boolean }): string {
  return JSON.stringify({ context, canBlock: options.canBlock ?? false })
}

function logHookFailure(event: HookEvent, filePath: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[opencode-hooks] ${event} hook from ${filePath} failed: ${message}`)
}
