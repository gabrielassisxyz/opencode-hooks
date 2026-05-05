import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { executeBashHook } from "./bash-executor.js";
import type { BashExecutionRequest } from "./bash-types.js";
import type { HookMap } from "./types.js";
type ExecuteBashHook = (request: BashExecutionRequest) => ReturnType<typeof executeBashHook>;
export interface CreateHooksRuntimeOptions {
    readonly hooks?: HookMap;
    readonly executeBash?: ExecuteBashHook;
}
export declare function createHooksRuntime(input: PluginInput, options?: CreateHooksRuntimeOptions): Hooks;
export {};
