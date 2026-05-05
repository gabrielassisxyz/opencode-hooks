export interface HookConfigDiscoveryOptions {
    readonly projectDir?: string;
    readonly platform?: string;
    readonly homeDir?: string;
    readonly appDataDir?: string;
    readonly exists?: (filePath: string) => boolean;
}
export interface HookConfigPaths {
    readonly global?: string;
    readonly project?: string;
}
export declare function resolveHookConfigPaths(options?: HookConfigDiscoveryOptions): HookConfigPaths;
export declare function discoverHookConfigPaths(options?: HookConfigDiscoveryOptions): string[];
