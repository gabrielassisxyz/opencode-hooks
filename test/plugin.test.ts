import { describe, expect, it } from "vitest"

import plugin from "../src/index.ts"

describe("plugin scaffold", () => {
  it("exports a default plugin function", () => {
    expect(typeof plugin).toBe("function")
  })
})
