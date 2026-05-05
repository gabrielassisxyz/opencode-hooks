import { type HookOverrideEntry, type HookMap, type HookValidationError, type ParsedHooksFile } from "./types.js";
import { type HookConfigDiscoveryOptions } from "./config-paths.js";
export interface HookDiscoveryResult {
    readonly hooks: HookMap;
    readonly errors: HookValidationError[];
    readonly files: string[];
}
export interface HookLoadOptions extends HookConfigDiscoveryOptions {
    readonly readFile?: (filePath: string) => string;
}
export interface HookLoadSnapshot extends HookDiscoveryResult {
    readonly signature: string;
}
type ParsedHooksFileResult = ParsedHooksFile & {
    readonly files: string[];
};
export declare function parseHooksFile(filePath: string, content: string): ParsedHooksFileResult;
export declare function loadHooksFile(filePath: string, readFile?: (filePath: string) => string): ParsedHooksFileResult;
export declare function loadDiscoveredHooks(options?: HookLoadOptions): HookDiscoveryResult;
export declare function loadDiscoveredHooksSnapshot(options?: HookLoadOptions): HookLoadSnapshot;
export declare function mergeHookMaps(...hookMaps: HookMap[]): HookMap;
export declare function resolveOverrides(hooks: HookMap, overrides: HookOverrideEntry[]): {
    hooks: HookMap;
    errors: HookValidationError[];
};
export {};
