import { describe, expect, it } from "vitest"

import { OpencodeHooksPlugin } from "../src/index.ts"

describe("plugin scaffold", () => {
  it("exports a default plugin function", () => {
    expect(typeof OpencodeHooksPlugin).toBe("function")
  })
})
