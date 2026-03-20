export interface HooksRuntime {
  readonly version: string
}

export function createHooksRuntime(): HooksRuntime {
  return {
    version: "0.1.0",
  }
}
