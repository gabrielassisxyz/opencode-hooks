import { readFileSync } from "node:fs"

import YAML from "yaml"

import {
  type HookAction,
  type HookBashActionConfig,
  type HookCommandActionConfig,
  type HookCondition,
  type HookConfig,
  type HookRunIn,
  type HookScope,
  type HookMap,
  type HookToolActionConfig,
  type HookValidationError,
  isHookCondition,
  isHookEvent,
  isHookRunIn,
  isHookScope,
} from "./types.js"
import { discoverHookConfigPaths, type HookConfigDiscoveryOptions } from "./config-paths.js"

export interface HookDiscoveryResult {
  readonly hooks: HookMap
  readonly errors: HookValidationError[]
  readonly files: string[]
}

export interface HookLoadOptions extends HookConfigDiscoveryOptions {
  readonly readFile?: (filePath: string) => string
}

export function parseHooksFile(filePath: string, content: string): HookDiscoveryResult {
  const document = YAML.parseDocument(content)
  if (document.errors.length > 0) {
    return {
      hooks: new Map(),
      errors: [{ code: "invalid_frontmatter", filePath, message: document.errors[0]?.message ?? "Failed to parse hooks.yaml." }],
      files: [filePath],
    }
  }

  const parsed = document.toJS()

  if (!isRecord(parsed)) {
    return {
      hooks: new Map(),
      errors: [{ code: "invalid_frontmatter", filePath, message: "hooks.yaml must parse to an object." }],
      files: [filePath],
    }
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "hooks")) {
    return {
      hooks: new Map(),
      errors: [{ code: "missing_hooks", filePath, message: "hooks.yaml must define a hooks list.", path: "hooks" }],
      files: [filePath],
    }
  }

  if (!Array.isArray(parsed.hooks)) {
    return {
      hooks: new Map(),
      errors: [{ code: "invalid_hooks", filePath, message: "hooks must be an array.", path: "hooks" }],
      files: [filePath],
    }
  }

  const hooks = new Map<HookConfig["event"], HookConfig[]>()
  const errors: HookValidationError[] = []

  parsed.hooks.forEach((hookDefinition, index) => {
    const parsedHook = parseHookDefinition(filePath, hookDefinition, index)
    errors.push(...parsedHook.errors)
    if (!parsedHook.hook) {
      return
    }

    const existing = hooks.get(parsedHook.hook.event) ?? []
    hooks.set(parsedHook.hook.event, [...existing, parsedHook.hook])
  })

  return { hooks, errors, files: [filePath] }
}

export function loadHooksFile(filePath: string, readFile: (filePath: string) => string = defaultReadFile): HookDiscoveryResult {
  return parseHooksFile(filePath, readFile(filePath))
}

export function loadDiscoveredHooks(options: HookLoadOptions = {}): HookDiscoveryResult {
  const files = discoverHookConfigPaths(options)
  const hooks = new Map<HookConfig["event"], HookConfig[]>()
  const errors: HookValidationError[] = []

  for (const filePath of files) {
    const result = loadHooksFile(filePath, options.readFile)
    mergeHookMapsInto(hooks, result.hooks)
    errors.push(...result.errors)
  }

  return { hooks, errors, files }
}

export function mergeHookMaps(...hookMaps: HookMap[]): HookMap {
  const merged = new Map<HookConfig["event"], HookConfig[]>()
  for (const hookMap of hookMaps) {
    mergeHookMapsInto(merged, hookMap)
  }
  return merged
}

function mergeHookMapsInto(target: HookMap, source: HookMap): void {
  for (const [event, configs] of source) {
    target.set(event, [...(target.get(event) ?? []), ...configs])
  }
}

function parseHookDefinition(
  filePath: string,
  hookDefinition: unknown,
  index: number,
): { hook?: HookConfig; errors: HookValidationError[] } {
  if (!isRecord(hookDefinition)) {
    return { errors: [createError(filePath, "invalid_hook", `hooks[${index}] must be an object.`, `hooks[${index}]`)] }
  }

  const event = hookDefinition.event
  if (!isHookEvent(event)) {
    return { errors: [createError(filePath, "invalid_event", `hooks[${index}].event is not a supported hook event.`, `hooks[${index}].event`)] }
  }

  const scopeResult = parseScope(filePath, hookDefinition.scope, index)
  const runInResult = parseRunIn(filePath, hookDefinition.runIn, index)

  const conditionsResult = parseConditions(filePath, hookDefinition.conditions, index)
  const actionsResult = parseActions(filePath, hookDefinition.actions, index)
  const errors = [...scopeResult.errors, ...runInResult.errors, ...conditionsResult.errors, ...actionsResult.errors]

  if (errors.length > 0 || actionsResult.actions.length === 0) {
    return { errors }
  }

  return {
    hook: {
      event,
      actions: actionsResult.actions,
      scope: scopeResult.scope,
      runIn: runInResult.runIn,
      ...(conditionsResult.conditions ? { conditions: conditionsResult.conditions } : {}),
      source: { filePath, index },
    },
    errors,
  }
}

function parseScope(filePath: string, scope: unknown, index: number): { scope: HookScope; errors: HookValidationError[] } {
  if (scope === undefined) {
    return { scope: "all", errors: [] }
  }

  if (!isHookScope(scope)) {
    return {
      scope: "all",
      errors: [createError(filePath, "invalid_scope", `hooks[${index}].scope must be one of: all, main, child.`, `hooks[${index}].scope`)],
    }
  }

  return { scope, errors: [] }
}

function parseRunIn(filePath: string, runIn: unknown, index: number): { runIn: HookRunIn; errors: HookValidationError[] } {
  if (runIn === undefined) {
    return { runIn: "current", errors: [] }
  }

  if (!isHookRunIn(runIn)) {
    return {
      runIn: "current",
      errors: [createError(filePath, "invalid_run_in", `hooks[${index}].runIn must be one of: current, main.`, `hooks[${index}].runIn`)],
    }
  }

  return { runIn, errors: [] }
}

function parseConditions(
  filePath: string,
  conditions: unknown,
  index: number,
): { conditions?: HookCondition[]; errors: HookValidationError[] } {
  if (conditions === undefined) {
    return { errors: [] }
  }

  if (!Array.isArray(conditions)) {
    return {
      errors: [createError(filePath, "invalid_conditions", `hooks[${index}].conditions must be an array.`, `hooks[${index}].conditions`)],
    }
  }

  const invalidIndex = conditions.findIndex((condition) => !isHookCondition(condition))
  if (invalidIndex >= 0) {
    return {
      errors: [createError(filePath, "invalid_conditions", `hooks[${index}].conditions[${invalidIndex}] is not a supported condition.`, `hooks[${index}].conditions[${invalidIndex}]`)],
    }
  }

  return { conditions: [...conditions], errors: [] }
}

function parseActions(
  filePath: string,
  actions: unknown,
  index: number,
): { actions: HookAction[]; errors: HookValidationError[] } {
  if (!Array.isArray(actions)) {
    return {
      actions: [],
      errors: [createError(filePath, "invalid_actions", `hooks[${index}].actions must be a non-empty array.`, `hooks[${index}].actions`)],
    }
  }

  if (actions.length === 0) {
    return {
      actions: [],
      errors: [createError(filePath, "invalid_actions", `hooks[${index}].actions must be a non-empty array.`, `hooks[${index}].actions`)],
    }
  }

  const parsedActions: HookAction[] = []
  const errors: HookValidationError[] = []

  actions.forEach((action, actionIndex) => {
    const parsedAction = parseAction(filePath, action, index, actionIndex)
    if (parsedAction.action) {
      parsedActions.push(parsedAction.action)
    }
    errors.push(...parsedAction.errors)
  })

  return { actions: parsedActions, errors }
}

function parseAction(
  filePath: string,
  action: unknown,
  hookIndex: number,
  actionIndex: number,
): { action?: HookAction; errors: HookValidationError[] } {
  const path = `hooks[${hookIndex}].actions[${actionIndex}]`
  if (!isRecord(action)) {
    return { errors: [createError(filePath, "invalid_action", `${path} must be an object.`, path)] }
  }

  const keys = ["command", "tool", "bash"].filter((key) => key in action)
  if (keys.length !== 1) {
    return { errors: [createError(filePath, "invalid_action", `${path} must define exactly one of command, tool, or bash.`, path)] }
  }

  if ("command" in action) {
    const command = parseCommandAction(action.command)
    return command
      ? { action: { command }, errors: [] }
      : { errors: [createError(filePath, "invalid_action", `${path}.command must be a string or { name, args? }.`, `${path}.command`)] }
  }

  if ("tool" in action) {
    const tool = parseToolAction(action.tool)
    return tool
      ? { action: { tool }, errors: [] }
      : { errors: [createError(filePath, "invalid_action", `${path}.tool must be { name, args? }.`, `${path}.tool`)] }
  }

  const bash = parseBashAction(action.bash)
  return bash
    ? { action: { bash }, errors: [] }
    : { errors: [createError(filePath, "invalid_action", `${path}.bash must be a string or { command, timeout? }.`, `${path}.bash`)] }
}

function parseCommandAction(value: unknown): string | HookCommandActionConfig | undefined {
  if (isNonEmptyString(value)) {
    return value
  }

  if (!isRecord(value) || !isNonEmptyString(value.name)) {
    return undefined
  }

  if (value.args !== undefined && typeof value.args !== "string") {
    return undefined
  }

  return value.args !== undefined ? { name: value.name, args: value.args } : { name: value.name }
}

function parseToolAction(value: unknown): HookToolActionConfig | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.name)) {
    return undefined
  }

  if (value.args !== undefined && !isRecord(value.args)) {
    return undefined
  }

  return value.args !== undefined ? { name: value.name, args: value.args } : { name: value.name }
}

function parseBashAction(value: unknown): string | HookBashActionConfig | undefined {
  if (isNonEmptyString(value)) {
    return value
  }

  if (!isRecord(value) || !isNonEmptyString(value.command)) {
    return undefined
  }

  const timeout = value.timeout
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)) {
    return undefined
  }

  return timeout !== undefined ? { command: value.command, timeout } : { command: value.command }
}

function createError(filePath: string, code: HookValidationError["code"], message: string, errorPath?: string): HookValidationError {
  return {
    code,
    filePath,
    message,
    ...(errorPath ? { path: errorPath } : {}),
  }
}

function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, "utf8")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
