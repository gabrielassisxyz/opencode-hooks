import type { FileChange } from "./types.js"

export interface PendingToolCall {
  readonly sessionID: string
  readonly toolArgs: Record<string, unknown>
}

interface SessionRecord {
  isMainSession?: boolean
  changes: FileChange[]
  changeKeys: Set<string>
}

export class SessionStateStore {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly pendingToolCalls = new Map<string, PendingToolCall>()

  rememberSession(sessionID: string, parentID?: string | null): void {
    const record = this.getOrCreateSession(sessionID)
    record.isMainSession = !parentID
  }

  async isMainSession(
    sessionID: string,
    resolveParentID: (sessionID: string) => Promise<string | null | undefined>,
  ): Promise<boolean> {
    const record = this.getOrCreateSession(sessionID)
    if (record.isMainSession !== undefined) {
      return record.isMainSession
    }

    record.isMainSession = !(await resolveParentID(sessionID))
    return record.isMainSession
  }

  deleteSession(sessionID: string): void {
    this.sessions.delete(sessionID)

    for (const [callID, pending] of this.pendingToolCalls) {
      if (pending.sessionID === sessionID) {
        this.pendingToolCalls.delete(callID)
      }
    }
  }

  setPendingToolCall(callID: string, sessionID: string, toolArgs: Record<string, unknown>): void {
    this.pendingToolCalls.set(callID, { sessionID, toolArgs })
  }

  consumePendingToolCall(callID: string): PendingToolCall | undefined {
    const pending = this.pendingToolCalls.get(callID)
    if (!pending) {
      return undefined
    }

    this.pendingToolCalls.delete(callID)
    return pending
  }

  addFileChanges(sessionID: string, changes: Iterable<FileChange>): void {
    const record = this.getOrCreateSession(sessionID)
    for (const change of changes) {
      const key = serializeFileChange(change)
      if (!record.changeKeys.has(key)) {
        record.changeKeys.add(key)
        record.changes.push(change)
      }
    }
  }

  getFileChanges(sessionID: string): FileChange[] {
    const record = this.sessions.get(sessionID)
    if (!record || record.changes.length === 0) {
      return []
    }

    return [...record.changes]
  }

  getModifiedPaths(sessionID: string): string[] {
    return getChangedPaths(this.getFileChanges(sessionID))
  }

  clearModifiedPaths(sessionID: string): void {
    const record = this.sessions.get(sessionID)
    if (!record) {
      return
    }

    record.changes = []
    record.changeKeys.clear()
  }

  private getOrCreateSession(sessionID: string): SessionRecord {
    let record = this.sessions.get(sessionID)
    if (!record) {
      record = { changes: [], changeKeys: new Set() }
      this.sessions.set(sessionID, record)
    }
    return record
  }
}

function getChangedPaths(changes: readonly FileChange[]): string[] {
  const paths = new Set<string>()

  for (const change of changes) {
    if (change.operation === "rename") {
      if (change.fromPath) {
        paths.add(change.fromPath)
      }
      if (change.toPath) {
        paths.add(change.toPath)
      }
      continue
    }

    if (change.path) {
      paths.add(change.path)
    }
  }

  return Array.from(paths)
}

function serializeFileChange(change: FileChange): string {
  if (change.operation === "rename") {
    return `${change.operation}:${change.fromPath}->${change.toPath}`
  }

  return `${change.operation}:${change.path}`
}
