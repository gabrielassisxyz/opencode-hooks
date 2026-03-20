export interface PendingToolCall {
  readonly sessionID: string
  readonly toolArgs: Record<string, unknown>
}

interface SessionRecord {
  isMainSession?: boolean
  modifiedPaths: Set<string>
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

  addModifiedPaths(sessionID: string, filePaths: Iterable<string>): void {
    const record = this.getOrCreateSession(sessionID)
    for (const filePath of filePaths) {
      if (filePath) {
        record.modifiedPaths.add(filePath)
      }
    }
  }

  getModifiedPaths(sessionID: string): string[] {
    const record = this.sessions.get(sessionID)
    if (!record || record.modifiedPaths.size === 0) {
      return []
    }

    return Array.from(record.modifiedPaths)
  }

  clearModifiedPaths(sessionID: string): void {
    const record = this.sessions.get(sessionID)
    if (!record) {
      return
    }

    record.modifiedPaths.clear()
  }

  private getOrCreateSession(sessionID: string): SessionRecord {
    let record = this.sessions.get(sessionID)
    if (!record) {
      record = { modifiedPaths: new Set() }
      this.sessions.set(sessionID, record)
    }
    return record
  }
}
