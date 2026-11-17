import { expect, test } from "bun:test"
import {
  DEFAULT_TOKEN_CEILING,
  admit,
  attach,
  configuredCeiling,
  evaluate,
  grantRemaining,
  grant,
  markExecutionTerminal,
  markStepStarted,
  monotonicHighWater,
  nextGrant,
  parseStartCeiling,
  reportedTokens,
  recordStepCompletion,
} from "../../src/budget"
import { memoryContext, sessionInfo, tokenUsage } from "./support/context"

test("the public option defaults to 40 million and accepts only positive safe integers", () => {
  expect(configuredCeiling({})).toEqual({ value: DEFAULT_TOKEN_CEILING })
  expect(configuredCeiling({ tokenCeiling: 100 })).toEqual({ value: 100 })
  for (const tokenCeiling of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "100"])
    expect(configuredCeiling({ tokenCeiling }).error).toContain("positive safe integer")
  expect(configuredCeiling(null).error).toContain("object")
  expect(parseStartCeiling("100")).toBe(100)
  for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992", "1e3"])
    expect(parseStartCeiling(value)).toBeUndefined()
})

test("family usage counts every normalized token category exactly once", () => {
  expect(
    reportedTokens({
      input: 3,
      output: 2,
      reasoning: 1,
      cache: { read: 1, write: 1 },
    }),
  ).toBe(8)
  expect(reportedTokens(undefined)).toBeUndefined()
  expect(reportedTokens({ input: Number.NaN, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })).toBeUndefined()
})

test("member high-water marks never refund duplicate, decreased, or deleted Session totals", () => {
  expect(monotonicHighWater(100, 100)).toBe(100)
  expect(monotonicHighWater(100, 50)).toBe(100)
  expect(monotonicHighWater(100, 150)).toBe(150)
})

test("the first grant carries overshoot and repeated grants compound only the selected Session", () => {
  const first = nextGrant(100_000, 105_000, 30_000)
  expect(first).toEqual({ offset: 75_000, ceiling: 125_000 })
  if (!first) throw new Error("Expected the blocked Session to receive its first grant")
  expect(grantRemaining(30_000, first)).toBe(20_000)

  expect(grantRemaining(30_000, first)).toBe(20_000)
  expect(grantRemaining(40_000, first)).toBe(10_000)

  const second = nextGrant(100_000, 120_000, 40_000, first)
  expect(second).toEqual({ offset: 75_000, ceiling: 156_250 })
  if (!second) throw new Error("Expected the blocked Session to receive its compounded grant")
  expect(grantRemaining(40_000, second)).toBe(41_250)
  expect(grantRemaining(82_000, second)).toBe(0)
  expect(nextGrant(100_000, 99_999, 30_000)).toBeUndefined()
})

test("explicit attachment starts a fresh window from the current native usage", async () => {
  const root = sessionInfo({ id: "ses_existing", tokens: 20, idle: 2 })
  const ctx = memoryContext([root]).ctx
  const attached = await attach(ctx, root.id, 50)

  expect(attached.allowed).toBe(true)
  expect(attached.familyUsage).toBe(0)
  expect(attached.sessionUsage).toBe(0)
  expect(attached.remaining).toBe(50)
})

test("an idle-only transition does not turn known attached usage into unknown usage", async () => {
  const root = sessionInfo({ id: "ses_idle", tokens: 20, idle: 2 })
  const memory = memoryContext([root])
  await attach(memory.ctx, root.id, 50)
  memory.updateIdle(root.id, 3)

  const snapshot = await evaluate(memory.ctx, root.id, { value: 50 })

  expect(snapshot.allowed).toBe(true)
  expect(snapshot.reason).toBeUndefined()
  expect(snapshot.familyUsage).toBe(0)
  expect(snapshot.remaining).toBe(50)
})

test("repeated primary preparation without a completed model step does not poison the family", async () => {
  const root = sessionInfo({ id: "ses_prepare" })
  const ctx = memoryContext([root]).ctx

  expect((await admit(ctx, root.id, { value: 50 })).allowed).toBe(true)
  const repeated = await admit(ctx, root.id, { value: 50 })

  expect(repeated.allowed).toBe(true)
  expect(repeated.reason).toBeUndefined()
})

test("deleting a member with unresolved admitted work cannot make its usage free", async () => {
  const root = sessionInfo({ id: "ses_family" })
  const child = sessionInfo({ id: "ses_child", parentID: root.id })
  const memory = memoryContext([root])
  const ceiling = { value: 10 }
  await admit(memory.ctx, root.id, ceiling)
  memory.add(child)
  await admit(memory.ctx, child.id, ceiling)
  memory.updateUsage(child.id, 20)
  memory.remove(child.id)

  const snapshot = await evaluate(memory.ctx, root.id, ceiling)

  expect(snapshot.allowed).toBe(false)
  expect(snapshot.reason).toBe("unavailable")
})

test("an existing multi-member attachment counts only growth from its per-member baselines", async () => {
  const root = sessionInfo({ id: "ses_baseline_root", tokens: 20, idle: 2 })
  const child = sessionInfo({ id: "ses_baseline_child", parentID: root.id, tokens: 10, idle: 3 })
  const newChild = sessionInfo({ id: "ses_new_child", parentID: root.id, tokens: 7 })
  const memory = memoryContext([root, child])
  const attached = await attach(memory.ctx, root.id, 50)

  expect(attached.familyUsage).toBe(0)
  expect(attached.remaining).toBe(50)
  memory.updateUsage(root.id, 25)
  memory.add(newChild)

  const grown = await evaluate(memory.ctx, root.id, { value: 50 })
  expect(grown.familyUsage).toBe(12)
  expect(grown.sessionUsage).toBe(5)
  expect(grown.remaining).toBe(38)

  memory.remove(child.id)
  expect((await evaluate(memory.ctx, root.id, { value: 50 })).familyUsage).toBe(12)
})

test("session-local grants use baseline-adjusted family and Session growth", async () => {
  const root = sessionInfo({ id: "ses_grant_root", tokens: 20, idle: 2 })
  const child = sessionInfo({ id: "ses_grant_child", parentID: root.id, tokens: 10, idle: 3 })
  const memory = memoryContext([root, child])
  await attach(memory.ctx, root.id, 100)
  memory.updateUsage(root.id, 50)
  memory.updateUsage(child.id, 85)

  const first = await grant(memory.ctx, root.id, { value: 100 })
  expect(first.familyUsage).toBe(105)
  expect(first.sessionUsage).toBe(30)
  expect(first.grant).toEqual({ offset: 75, ceiling: 125 })
  expect(first.remaining).toBe(20)

  memory.updateUsage(child.id, 95)
  const afterSiblingGrowth = await evaluate(memory.ctx, root.id, { value: 100 })
  expect(afterSiblingGrowth.familyUsage).toBe(115)
  expect(afterSiblingGrowth.remaining).toBe(20)
})

test("a positive completed step refreshes native usage before a child is deleted", async () => {
  const root = sessionInfo({ id: "ses_deleted_root" })
  const child = sessionInfo({ id: "ses_completed_child", parentID: root.id })
  const memory = memoryContext([root, child])
  const ceiling = { value: 10 }
  await admit(memory.ctx, root.id, ceiling)
  await admit(memory.ctx, child.id, ceiling)
  await markStepStarted(memory.ctx, child.id)
  memory.updateUsage(child.id, 20)
  await recordStepCompletion(memory.ctx, child.id, tokenUsage(20))
  memory.remove(child.id)

  const snapshot = await evaluate(memory.ctx, root.id, ceiling)

  expect(snapshot.allowed).toBe(false)
  expect(snapshot.reason).toBe("ceiling")
  expect(snapshot.familyUsage).toBe(20)
})

test("a positive completion observed after member deletion makes the family unavailable", async () => {
  const root = sessionInfo({ id: "ses_late_event_root" })
  const child = sessionInfo({ id: "ses_late_event_child", parentID: root.id })
  const memory = memoryContext([root, child])
  const ceiling = { value: 10 }
  await admit(memory.ctx, root.id, ceiling)
  await admit(memory.ctx, child.id, ceiling)
  await markStepStarted(memory.ctx, child.id)
  memory.remove(child.id)
  await recordStepCompletion(memory.ctx, child.id, tokenUsage(20))

  const snapshot = await evaluate(memory.ctx, root.id, ceiling)

  expect(snapshot.allowed).toBe(false)
  expect(snapshot.reason).toBe("unavailable")
})

test("missing usage on an actual completed step fails closed", async () => {
  const root = sessionInfo({ id: "ses_missing_step_usage" })
  const memory = memoryContext([root])
  await admit(memory.ctx, root.id, { value: 50 })
  await markStepStarted(memory.ctx, root.id)
  await recordStepCompletion(memory.ctx, root.id, undefined)

  const snapshot = await evaluate(memory.ctx, root.id, { value: 50 })
  expect(snapshot.allowed).toBe(false)
  expect(snapshot.reason).toBe("unavailable")
})

test("a control-only terminal clears a prepared request without poisoning the family", async () => {
  const root = sessionInfo({ id: "ses_control_terminal" })
  const memory = memoryContext([root])
  await admit(memory.ctx, root.id, { value: 50 })
  await markExecutionTerminal(memory.ctx, root.id)

  const snapshot = await evaluate(memory.ctx, root.id, { value: 50 })
  expect(snapshot.allowed).toBe(true)
  expect(snapshot.reason).toBeUndefined()
})
