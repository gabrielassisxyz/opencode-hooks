import type { Plugin } from "@opencode-ai/plugin"

import { createOpencodeHooksPlugin } from "./adapter/opencode.js"

const OpencodeHooksPlugin: Plugin = async (input) => {
  return createOpencodeHooksPlugin(input)
}

export default OpencodeHooksPlugin
