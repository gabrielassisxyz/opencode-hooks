import type { Hooks, PluginInput } from "@opencode-ai/plugin"

import { createHooksRuntime } from "../core/runtime.js"

export async function createOpencodeHooksPlugin(_input: PluginInput): Promise<Hooks> {
  return createHooksRuntime(_input)
}
