export declare const SESSION_HOOK_EVENTS: readonly ["session.idle", "session.created", "session.deleted", "file.changed", "message.updated", "message.part.updated"];
export declare const LEGACY_HOOK_CONDITIONS: readonly ["matchesCodeFiles"];
export declare const PATH_HOOK_CONDITION_KEYS: readonly ["matchesAnyPath", "matchesAllPaths"];
export declare const HOOK_SCOPES: readonly ["all", "main", "child"];
export declare const HOOK_RUN_IN: readonly ["current", "main"];
export declare const HOOK_BEHAVIORS: readonly ["stop"];
export type SessionHookEvent = (typeof SESSION_HOOK_EVENTS)[number];
export type ToolHookPhase = "before" | "after";
export type ToolHookEvent = `tool.${ToolHookPhase}.*` | `tool.${ToolHookPhase}.${string}`;
export type HookEvent = SessionHookEvent | ToolHookEvent;
export type HookLegacyCondition = (typeof LEGACY_HOOK_CONDITIONS)[number];
export type HookPathConditionKey = (typeof PATH_HOOK_CONDITION_KEYS)[number];
export type HookPathCondition = {
    readonly matchesAnyPath: readonly string[];
} | {
    readonly matchesAllPaths: readonly string[];
};
export type HookCondition = HookLegacyCondition | HookPathCondition;
export type HookScope = (typeof HOOK_SCOPES)[number];
export type HookRunIn = (typeof HOOK_RUN_IN)[number];
export type HookBehavior = (typeof HOOK_BEHAVIORS)[number];
export interface CreateFileChange {
    readonly operation: "create";
    readonly path: string;
}
export interface ModifyFileChange {
    readonly operation: "modify";
    readonly path: string;
}
export interface DeleteFileChange {
    readonly operation: "delete";
    readonly path: string;
}
export interface RenameFileChange {
    readonly operation: "rename";
    readonly fromPath: string;
    readonly toPath: string;
}
export type FileChange = CreateFileChange | ModifyFileChange | DeleteFileChange | RenameFileChange;
export interface HookCommandActionConfig {
    readonly name: string;
    readonly args?: string;
}
export interface HookToolActionConfig {
    readonly name: string;
    readonly args?: Record<string, unknown>;
}
export interface HookBashActionConfig {
    readonly command: string;
    readonly timeout?: number;
}
export interface HookCommandAction {
    readonly command: string | HookCommandActionConfig;
}
export interface HookToolAction {
    readonly tool: HookToolActionConfig;
}
export interface HookBashAction {
    readonly bash: string | HookBashActionConfig;
}
export type HookAction = HookCommandAction | HookToolAction | HookBashAction;
export interface HookConfigSource {
    readonly filePath: string;
    readonly index: number;
}
export interface HookConfig {
    readonly id?: string;
    readonly event: HookEvent;
    readonly action?: HookBehavior;
    readonly actions: HookAction[];
    readonly scope: HookScope;
    readonly runIn: HookRunIn;
    readonly async?: boolean;
    readonly conditions?: HookCondition[];
    readonly source: HookConfigSource;
}
export interface HookOverrideEntry {
    readonly targetId: string;
    readonly disable: boolean;
    readonly replacement?: HookConfig;
    readonly source: HookConfigSource;
}
export type HookMap = Map<HookEvent, HookConfig[]>;
export type HookValidationErrorCode = "invalid_frontmatter" | "missing_hooks" | "invalid_hooks" | "invalid_hook" | "invalid_event" | "invalid_scope" | "invalid_run_in" | "invalid_hook_action" | "invalid_conditions" | "invalid_actions" | "invalid_action" | "duplicate_hook_id" | "override_target_not_found" | "invalid_override" | "invalid_async";
export interface HookValidationError {
    readonly code: HookValidationErrorCode;
    readonly filePath: string;
    readonly message: string;
    readonly path?: string;
}
export interface ParsedHooksFile {
    readonly hooks: HookMap;
    readonly overrides: HookOverrideEntry[];
    readonly errors: HookValidationError[];
}
export declare function isHookEvent(value: unknown): value is HookEvent;
export declare function isHookLegacyCondition(value: unknown): value is HookLegacyCondition;
export declare function isHookPathConditionKey(value: unknown): value is HookPathConditionKey;
export declare function isHookScope(value: unknown): value is HookScope;
export declare function isHookRunIn(value: unknown): value is HookRunIn;
export declare function isHookBehavior(value: unknown): value is HookBehavior;
