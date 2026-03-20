export const SESSION_HOOK_EVENTS = ["session.idle", "session.created", "session.deleted"] as const
export const HOOK_CONDITIONS = ["isMainSession", "hasCodeChange"] as const

export type SessionHookEvent = (typeof SESSION_HOOK_EVENTS)[number]
export type ToolHookPhase = "before" | "after"
export type ToolHookEvent = `tool.${ToolHookPhase}.*` | `tool.${ToolHookPhase}.${string}`
export type HookEvent = SessionHookEvent | ToolHookEvent
export type HookCondition = (typeof HOOK_CONDITIONS)[number]

export interface HookCommandActionConfig {
  readonly name: string
  readonly args?: string
}

export interface HookToolActionConfig {
  readonly name: string
  readonly args?: Record<string, unknown>
}

export interface HookBashActionConfig {
  readonly command: string
  readonly timeout?: number
}

export interface HookCommandAction {
  readonly command: string | HookCommandActionConfig
}

export interface HookToolAction {
  readonly tool: HookToolActionConfig
}

export interface HookBashAction {
  readonly bash: string | HookBashActionConfig
}

export type HookAction = HookCommandAction | HookToolAction | HookBashAction

export interface HookConfigSource {
  readonly filePath: string
  readonly index: number
}

export interface HookConfig {
  readonly event: HookEvent
  readonly actions: HookAction[]
  readonly conditions?: HookCondition[]
  readonly source: HookConfigSource
}

export type HookMap = Map<HookEvent, HookConfig[]>

export type HookValidationErrorCode =
  | "invalid_frontmatter"
  | "missing_hooks"
  | "invalid_hooks"
  | "invalid_hook"
  | "invalid_event"
  | "invalid_conditions"
  | "invalid_actions"
  | "invalid_action"

export interface HookValidationError {
  readonly code: HookValidationErrorCode
  readonly filePath: string
  readonly message: string
  readonly path?: string
}

export interface ParsedHooksFile {
  readonly hooks: HookMap
  readonly errors: HookValidationError[]
}

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (SESSION_HOOK_EVENTS.includes(value as SessionHookEvent) || /^tool\.(before|after)\.(\*|.+)$/.test(value))
}

export function isHookCondition(value: unknown): value is HookCondition {
  return typeof value === "string" && HOOK_CONDITIONS.includes(value as HookCondition)
}
