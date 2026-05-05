import type { FileChange } from "./types.js";
export interface PendingToolCall {
    readonly sessionID: string;
    readonly toolArgs: Record<string, unknown>;
}
export type SessionScope = "all" | "main" | "child";
export declare class SessionStateStore {
    private readonly sessions;
    private readonly pendingToolCalls;
    rememberSession(sessionID: string, parentID?: string | null): void;
    evaluateScope(sessionID: string, scope: SessionScope, resolveParentID: (sessionID: string) => Promise<string | null | undefined>): Promise<boolean>;
    getRootSessionID(sessionID: string, resolveParentID: (sessionID: string) => Promise<string | null | undefined>): Promise<string>;
    isDeleted(sessionID: string): boolean;
    deleteSession(sessionID: string): void;
    setPendingToolCall(callID: string, sessionID: string, toolArgs: Record<string, unknown>): void;
    consumePendingToolCall(callID: string): PendingToolCall | undefined;
    addFileChanges(sessionID: string, changes: Iterable<FileChange>): void;
    getFileChanges(sessionID: string): FileChange[];
    getModifiedPaths(sessionID: string): string[];
    beginIdleDispatch(sessionID: string, changes: readonly FileChange[]): void;
    consumeFileChanges(sessionID: string, changes: readonly FileChange[]): void;
    cancelIdleDispatch(sessionID: string): void;
    addUserMessage(sessionID: string, messageID: string): void;
    isUserMessage(sessionID: string, messageID: string): boolean;
    private getOrCreateSession;
    private resolveRootSessionID;
}
