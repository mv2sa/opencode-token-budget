import { expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import type { OpenCode } from "@opencode/sdk"
import { TokenUsage } from "@opencode/schema/token-usage"

type EmbeddedHostBinding = OpenCode.Interface

const sdkBinding: EmbeddedHostBinding | undefined = undefined

test("pinned public SDK, plugin, and schema bindings resolve", () => {
  expect(typeof Plugin.define).toBe("function")
  expect(
    TokenUsage.total({
      input: 3,
      output: 2,
      reasoning: 1,
      cache: { read: 1, write: 1 },
    }),
  ).toBe(8)
  expect(sdkBinding).toBeUndefined()
})
