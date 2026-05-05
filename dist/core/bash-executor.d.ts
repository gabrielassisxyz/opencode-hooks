import { type BashExecutionRequest, type BashHookContext, type BashHookResult, type BashProcessResult } from "./bash-types.js";
export declare function executeBashHook(request: BashExecutionRequest): Promise<BashHookResult>;
export declare function mapBashProcessResultToHookResult(result: BashProcessResult, context: BashHookContext): BashHookResult;
export declare function isBlockingToolBeforeEvent(event: string): boolean;
