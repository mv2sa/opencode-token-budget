import { expect, test } from "bun:test"
import type { TokenUsage } from "@opencode/schema/token-usage"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { startHost, startProvider } from "../portable/helpers/host"
import type { HostReport, LocalProvider, ProviderCall, RunningHost } from "../portable/helpers/host"

const providerID = "budget-loopback"
const modelID = "fixture-model"
const pluginID = "opencode.token-budget"
const commandName = "budget"
const permission = [{ action: "*", resource: "*", effect: "allow" as const }]
const workspaceRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)))

test("production plugin shares native family usage and preserves selected-Session grants through child, fork, in-flight work, and reload", async () => {
  await runScenario("family-grants", async (scenario) => {
    const childResponse = deferred<Response>()
    const childRequest = deferred<ProviderCall>()
    const rootUsages = [10, 65]
    let rootID: string | undefined
    let forkID: string | undefined
    let childID: string | undefined
    let nestedChildID: string | undefined
    let unrelatedID: string | undefined
    let rootCalls = 0
    let localGrantUse = 0
    let childHost: RunningHost | undefined
    let childWasReceived = false
    let childSettled = false
    scenario.onSettle(async () => {
      childResponse.resolve(completion(35, "child CI completed"))
      if (childWasReceived && !childSettled && childID && childHost) await childHost.waitForTerminal(childID)
    })

    const provider = await scenario.createProvider((call) => {
      if (call.sessionID === childID) {
        childRequest.resolve(call)
        return childResponse.promise
      }
      if (call.sessionID === rootID) {
        rootCalls++
        if (rootCalls === 1 || rootCalls === 2) return completion(rootUsages.shift() ?? 1, "root response")
        if (rootCalls === 3) return completion(localGrantUse, "user-requested continuation")
        if (rootCalls === 4) return completion(40, "compounded grant overshoot")
        return completion(1, "unexpected root request")
      }
      if (call.sessionID === forkID) return completion(5, "fork response")
      if (call.sessionID === nestedChildID) return completion(25, "nested child response")
      if (call.sessionID === unrelatedID) return completion(1, "unrelated response")
      return completion(1, "unclassified local response")
    })

    let config = hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 100 })
    let host = await scenario.createHost(config)
    childHost = host
    const root = await createRoot(host, "Native budget family root")
    rootID = root.id
    await clientPrompt(host, root.id, "Start the root Session.")
    await host.waitForSuccess(root.id)
    expect(count(provider, root.id)).toBe(1)
    expect(provider.calls[0]?.toolNames).not.toContain(commandName)

    await command(host, root.id, "status")
    const rootInitialStatus = parseStatus(await latestSynthetic(host, root.id))
    expect(rootInitialStatus.base).toBe(100)
    expect(rootInitialStatus.familyUsage).toBe(10)
    expect(count(provider, root.id)).toBe(1)
    await command(host, root.id, "+25%")
    expect(await latestSynthetic(host, root.id)).toContain("only when this Session is blocked")
    await command(host, root.id, "status")
    const noDeferredGrant = parseStatus(await latestSynthetic(host, root.id))
    expect(noDeferredGrant.grantCeiling).toBeUndefined()
    expect(noDeferredGrant.familyUsage).toBe(10)
    expect(count(provider, root.id)).toBe(1)

    const fork = await host.client.session.fork({ sessionID: root.id })
    forkID = fork.id
    const forkBefore = await host.client.session.get({ sessionID: fork.id })
    await command(host, fork.id, "status")
    const forkStatus = parseStatus(await latestSynthetic(host, fork.id))
    const rootBeforeFork = await host.client.session.get({ sessionID: root.id })
    expect(forkStatus.familyUsage).toBe(total(rootBeforeFork.tokens) + total(forkBefore.tokens))
    expect(count(provider, fork.id)).toBe(0)

    const child = await createChild(host, root.id, "Child running in another Location")
    childID = child.id
    await host.client.session.move({ sessionID: child.id, directory: host.secondProject })
    await host.waitForSuccess(child.id)
    expect((await host.client.session.get({ sessionID: child.id })).location.directory).toBe(host.secondProject)
    const childPrompt = host.client.session
      .prompt({ sessionID: child.id, text: "Wait for the local CI response." })
      .then(
        () => undefined,
        (error: unknown) => childRequest.reject(error),
      )
    const inFlightCall = await childRequest.promise
    childWasReceived = true
    expect(inFlightCall.sessionID).toBe(child.id)
    expect(inFlightCall.path).toBe("/v1/chat/completions")

    const nested = await createChild(host, child.id, "Nested child in the moved Location")
    nestedChildID = nested.id
    await clientPrompt(host, nested.id, "Do one small task.")
    await host.waitForSuccess(nested.id)
    expect(count(provider, nested.id)).toBe(1)

    await clientPrompt(host, root.id, "Continue the root task.")
    await host.waitForSuccess(root.id)
    expect(count(provider, root.id)).toBe(2)

    const beforeGrantInfos = await Promise.all(
      [root.id, fork.id, child.id, nested.id].map((sessionID) => host.client.session.get({ sessionID })),
    )
    const familyBeforeGrant = beforeGrantInfos.reduce((sum, info) => sum + total(info.tokens), 0)
    const rootUsageBeforeGrant = total(beforeGrantInfos.find((info) => info.id === root.id)?.tokens)
    expect(familyBeforeGrant).toBeGreaterThanOrEqual(100)
    expect(rootUsageBeforeGrant).toBe(75)
    await command(host, root.id, "+25%")
    expect(await latestSynthetic(host, root.id)).toContain("+25% granted to this Session only")
    await command(host, root.id, "status")
    const firstGrant = parseStatus(await latestSynthetic(host, root.id))
    expect(firstGrant.base).toBe(100)
    expect(firstGrant.grantCeiling).toBe(125)
    expect(firstGrant.familyUsage).toBe(familyBeforeGrant)
    expect(firstGrant.remaining).toBe(125 - familyBeforeGrant)
    expect(count(provider, root.id)).toBe(2)

    childResponse.resolve(completion(35, "child CI completed"))
    await childPrompt
    await host.waitForSuccess(child.id)
    childSettled = true
    expect(total((await host.client.session.get({ sessionID: child.id })).tokens)).toBe(35)
    expect((await host.client.session.list({ parentID: root.id })).data.some((info) => info.id === child.id)).toBe(true)
    await command(host, root.id, "status")
    const refreshedAfterChild = parseStatus(await latestSynthetic(host, root.id))
    expect(refreshedAfterChild.familyUsage).toBe(familyBeforeGrant + 35)
    expect(refreshedAfterChild.remaining).toBe(firstGrant.remaining)

    const nestedCount = count(provider, nested.id)
    await clientPrompt(host, nested.id, "Continue while the family is blocked.")
    const nestedBlocked = await host.waitForFailure(nested.id)
    expect(nestedBlocked.data.error.message).toContain("Token budget blocked:")
    expect(count(provider, nested.id)).toBe(nestedCount)

    localGrantUse = firstGrant.remaining
    await command(host, root.id, "continue")
    await host.waitForSuccess(root.id)
    expect(count(provider, root.id)).toBe(3)
    await command(host, root.id, "status")
    const spentFirstGrant = parseStatus(await latestSynthetic(host, root.id))
    expect(spentFirstGrant.grantCeiling).toBe(125)
    expect(spentFirstGrant.remaining).toBe(0)

    await command(host, root.id, "continue")
    await host.waitForSuccess(root.id)
    expect(count(provider, root.id)).toBe(4)
    await command(host, root.id, "status")
    const spentSecondGrant = parseStatus(await latestSynthetic(host, root.id))
    expect(spentSecondGrant.grantCeiling).toBe(157)
    expect(spentSecondGrant.remaining).toBe(0)
    const rootCountAfterOvershoot = count(provider, root.id)
    await clientPrompt(host, root.id, "No third grant was requested.")
    const rootBlocked = await host.waitForFailure(root.id)
    expect(rootBlocked.data.error.message).toContain("Token budget blocked:")
    expect(count(provider, root.id)).toBe(rootCountAfterOvershoot)

    const unrelated = await createRoot(host, "Unrelated healthy Session")
    unrelatedID = unrelated.id
    await clientPrompt(host, unrelated.id, "Respond normally.")
    await host.waitForSuccess(unrelated.id)
    expect(count(provider, unrelated.id)).toBe(1)
    expect(count(provider, root.id)).toBe(rootCountAfterOvershoot)

    await command(host, unrelated.id, "stop")
    const unrelatedBeforeStopPrompt = count(provider, unrelated.id)
    await clientPrompt(host, unrelated.id, "This ordinary prompt is manually stopped.")
    const manuallyStopped = await host.waitForFailure(unrelated.id)
    expect(manuallyStopped.data.error.message).toContain("manually paused")
    expect(count(provider, unrelated.id)).toBe(unrelatedBeforeStopPrompt)
    await command(host, unrelated.id, "continue")
    await host.waitForSuccess(unrelated.id)
    expect(count(provider, unrelated.id)).toBe(unrelatedBeforeStopPrompt + 1)

    const firstReport = await host.close()
    expect(firstReport.closed).toBe(true)
    config = hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 200 })
    host = await scenario.createHost(config)
    await command(host, root.id, "status")
    const afterReload = parseStatus(await latestSynthetic(host, root.id))
    expect(afterReload.base).toBe(100)
    expect(afterReload.grantCeiling).toBe(157)
    const future = await createRoot(host, "Future family after option change")
    await command(host, future.id, "status")
    const futureStatus = parseStatus(await latestSynthetic(host, future.id))
    expect(futureStatus.base).toBe(200)
    expect(count(provider, root.id)).toBe(rootCountAfterOvershoot)

    scenario.evidence.family = {
      rootID: root.id,
      forkID: fork.id,
      forkNativeUsage: total(forkBefore.tokens),
      childAtOtherLocationID: child.id,
      nestedChildID: nested.id,
      familyBeforeGrant,
      firstGrantOffset: familyBeforeGrant - rootUsageBeforeGrant,
      firstGrantCeiling: firstGrant.grantCeiling,
      firstGrantRemaining: firstGrant.remaining,
      remainingAfterInFlightSiblingUsage: refreshedAfterChild.remaining,
      secondGrantCeiling: spentSecondGrant.grantCeiling,
      unrelatedID: unrelated.id,
      futureFamilyBase: futureStatus.base,
      hostRestartPreservedBaseAndGrant: true,
    }
    scenario.evidence.providerRequestCounts = {
      root: count(provider, root.id),
      nestedChild: count(provider, nested.id),
      inFlightChild: count(provider, child.id),
      fork: count(provider, fork.id),
      unrelated: count(provider, unrelated.id),
      total: provider.calls.length,
    }
  })
})

test("explicit start attaches an existing Session at its current native usage baseline without replacement", async () => {
  await runScenario("explicit-start", async (scenario) => {
    let sessionID: string | undefined
    const provider = await scenario.createProvider((call) => completion(call.sessionID === sessionID ? 20 : 2, "pre-attach usage"))
    const locationConfig = hostConfig(provider.origin, workspaceRoot, undefined)
    let host = await scenario.createHost(locationConfig)
    const session = await createRoot(host, "Existing Session before plugin attachment")
    sessionID = session.id
    await clientPrompt(host, session.id, "Use the local fake provider before attachment.")
    await host.waitForSuccess(session.id)
    expect(total((await host.client.session.get({ sessionID: session.id })).tokens)).toBe(20)
    expect(count(provider, session.id)).toBe(1)
    const firstReport = await host.close()
    expect(firstReport.closed).toBe(true)

    host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 100 }))
    await command(host, session.id, "start 50")
    const attached = parseStatus(await latestSynthetic(host, session.id))
    expect(attached.base).toBe(50)
    expect(attached.familyUsage).toBe(0)
    expect(attached.sessionUsage).toBe(0)
    expect(attached.remaining).toBe(50)
    await command(host, session.id, "start 75")
    const refusedReplacement = await latestSynthetic(host, session.id)
    expect(refusedReplacement).toContain("already attached")
    await command(host, session.id, "status")
    expect(parseStatus(await latestSynthetic(host, session.id)).base).toBe(50)
    expect(count(provider, session.id)).toBe(1)
    await clientPrompt(host, session.id, "Continue using the attached baseline.")
    await host.waitForSuccess(session.id)
    expect(total((await host.client.session.get({ sessionID: session.id })).tokens)).toBe(40)
    expect(count(provider, session.id)).toBe(2)
    await command(host, session.id, "status")
    const afterGrowth = parseStatus(await latestSynthetic(host, session.id))
    expect(afterGrowth.familyUsage).toBe(20)
    expect(afterGrowth.sessionUsage).toBe(20)
    expect(afterGrowth.remaining).toBe(30)
    expect((await host.close()).closed).toBe(true)
    host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 100 }))
    await command(host, session.id, "status")
    const afterReload = parseStatus(await latestSynthetic(host, session.id))
    expect(afterReload.base).toBe(50)
    expect(afterReload.familyUsage).toBe(20)
    expect(afterReload.sessionUsage).toBe(20)
    expect(afterReload.remaining).toBe(30)
    scenario.evidence.baseline = {
      sessionID: session.id,
      nativeUsageAtAttach: 20,
      base: attached.base,
      familyUsageAtAttach: attached.familyUsage,
      sessionUsageAtAttach: attached.sessionUsage,
      remainingAtAttach: attached.remaining,
      replacementRejected: true,
      nativeUsageAfterNewRequest: total((await host.client.session.get({ sessionID: session.id })).tokens),
      countedGrowthAfterAttach: afterGrowth.familyUsage,
      remainingAfterGrowth: afterGrowth.remaining,
      familyUsageAfterReload: afterReload.familyUsage,
      remainingAfterReload: afterReload.remaining,
    }
  })
})

test("a completed child deleted before the next parent request remains counted or fails closed", async () => {
  await runScenario("deleted-child-usage", async (scenario) => {
    let childID: string | undefined
    const provider = await scenario.createProvider((call) =>
      completion(call.sessionID === childID ? 20 : 2, "reported child usage"),
    )
    const host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 10 }))
    const root = await createRoot(host, "Deleted child usage family")
    const child = await createChild(host, root.id, "Child removed after completed work")
    childID = child.id
    const childStep = host.waitForStepEnded(child.id)
    await clientPrompt(host, child.id, "Complete one reported child step.")
    await host.waitForSuccess(child.id)
    const childStepEvent = await childStep
    expect(total(childStepEvent.data.tokens)).toBe(20)
    expect(total((await host.client.session.get({ sessionID: child.id })).tokens)).toBe(20)
    expect(count(provider, child.id)).toBe(1)

    await host.client.session.remove({ sessionID: child.id })
    await clientPrompt(host, root.id, "The deleted child's usage must still block this request.")
    const parentTerminal = await host.waitForTerminal(root.id)
    if (parentTerminal.type !== "session.execution.failed")
      throw new Error(`The parent request reached a provider after child deletion: ${parentTerminal.type}`)
    expect(parentTerminal.data.error.message).toMatch(/Token budget blocked:|usage accounting is unavailable/u)
    expect(count(provider, root.id)).toBe(0)

    scenario.evidence.deletedChild = {
      rootID: root.id,
      childID: child.id,
      childNativeUsageBeforeDelete: 20,
      completedStepUsageEvent: total(childStepEvent.data.tokens),
      childProviderRequests: count(provider, child.id),
      parentProviderRequestsAfterDelete: count(provider, root.id),
      parentTerminal: parentTerminal.type,
      parentError: parentTerminal.data.error,
    }
  })
})

test("a real pre-send hook rejection without a model step leaves the family usable", async () => {
  await runScenario("pre-send-rejection", async (scenario) => {
    let sessionID: string | undefined
    const provider = await scenario.createProvider((call) => completion(call.sessionID === sessionID ? 1 : 2, "second request"))
    const fixturePlugin = join(workspaceRoot, "test", "integration", "fixtures", "pre-send-reject-once")
    const host = await scenario.createHost(
      hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 50 }, [fixturePlugin]),
    )
    const session = await createRoot(host, "Pre-send rejection without a model step")
    sessionID = session.id
    await expect(
      host.client.session.generate({ sessionID: session.id, prompt: "The fixture rejects before provider dispatch." }),
    ).rejects.toThrow()
    expect(count(provider, session.id)).toBe(0)

    await command(host, session.id, "status")
    const afterRejection = await latestSynthetic(host, session.id)
    expect(afterRejection).not.toContain("usage accounting is unavailable")
    expect(afterRejection).toContain("remaining 50")

    await host.client.session.generate({ sessionID: session.id, prompt: "Now allow the actual provider request." })
    expect(count(provider, session.id)).toBe(1)
    scenario.evidence.preSendRejection = {
      sessionID: session.id,
      firstExecution: "public session.generate rejected before a model step",
      providerRequestsForRejectedExecution: 0,
      providerRequestsAfterRetryingGenerate: 1,
      familyRemainedAvailable: true,
    }
  })
})

test("an exhausted budget blocks the public auxiliary session.generate request before dispatch", async () => {
  await runScenario("exhausted-generate", async (scenario) => {
    const provider = await scenario.createProvider(() => completion(10, "primary response"))
    const host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 10 }))
    const session = await createRoot(host, "Exhausted auxiliary generation")
    await clientPrompt(host, session.id, "Exhaust the family budget first.")
    await host.waitForSuccess(session.id)
    expect(count(provider, session.id)).toBe(1)
    await expect(
      host.client.session.generate({ sessionID: session.id, prompt: "Try an auxiliary generation at the ceiling." }),
    ).rejects.toThrow()
    expect(count(provider, session.id)).toBe(1)

    scenario.evidence.exhaustedGenerate = {
      sessionID: session.id,
      kind: "generate",
      providerRequestsAfterExhaustion: count(provider, session.id),
    }
  })
})

test("the retry hook stops a real retry after a sibling reaches the family ceiling", async () => {
  await runScenario("retry-backstop", async (scenario) => {
    const releaseRootFailure = deferred<void>()
    const rootRequest = deferred<ProviderCall>()
    let rootID: string | undefined
    let siblingID: string | undefined
    const provider = await scenario.createProvider((call) => {
      if (call.sessionID === rootID) {
        rootRequest.resolve(call)
        return releaseRootFailure.promise.then(
          () => new Response("temporary local provider failure", { status: 503, headers: { "retry-after": "0", "x-should-retry": "true" } }),
        )
      }
      return completion(call.sessionID === siblingID ? 10 : 1, "sibling reaches the ceiling")
    })
    const host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 10 }))
    const root = await createRoot(host, "Retry backstop family")
    rootID = root.id
    const sibling = await createChild(host, root.id, "Sibling that exhausts the family")
    siblingID = sibling.id

    await clientPrompt(host, root.id, "Hold the retryable provider response.")
    expect((await rootRequest.promise).sessionID).toBe(root.id)
    await clientPrompt(host, sibling.id, "Reach the shared reported-token ceiling.")
    await host.waitForSuccess(sibling.id)
    expect(count(provider, sibling.id)).toBe(1)

    releaseRootFailure.resolve(undefined)
    const rootTerminal = await host.waitForFailure(root.id)
    expect(count(provider, root.id)).toBe(1)
    scenario.evidence.retryBackstop = {
      rootID: root.id,
      siblingID: sibling.id,
      siblingUsage: 10,
      rootProviderRequests: count(provider, root.id),
      siblingProviderRequests: count(provider, sibling.id),
      rootTerminal: rootTerminal.type,
    }
  })
})

test("zero or absent primary usage fails closed, and invalid tokenCeiling options block before provider dispatch", async () => {
  await runScenario("reporting-and-options", async (scenario) => {
    let reportingID: string | undefined
    const provider = await scenario.createProvider((call) => {
      if (call.sessionID === reportingID) return completion(5, "unreported usage", false)
      return completion(1, "invalid-option should never reach provider")
    })
    let host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, {}))
    const reporting = await createRoot(host, "Reported usage gap Session")
    reportingID = reporting.id
    await command(host, reporting.id, "status")
    expect(parseStatus(await latestSynthetic(host, reporting.id)).base).toBe(40_000_000)
    await clientPrompt(host, reporting.id, "Receive a response without usage metadata.")
    await host.waitForSuccess(reporting.id)
    expect(count(provider, reporting.id)).toBe(1)
    await clientPrompt(host, reporting.id, "This request is blocked because usage was unknown.")
    const unknownBlocked = await host.waitForFailure(reporting.id)
    expect(unknownBlocked.data.error.message).toContain("usage accounting is unavailable")
    expect(count(provider, reporting.id)).toBe(1)

    const firstReport = await host.close()
    expect(firstReport.closed).toBe(true)
    host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 0 }))
    const invalid = await createRoot(host, "Invalid option must fail closed")
    await command(host, invalid.id, "status")
    expect(await latestSynthetic(host, invalid.id)).toContain("Invalid token budget configuration")
    await clientPrompt(host, invalid.id, "Invalid tokenCeiling must not reach a provider.")
    const invalidFailure = await host.waitForFailure(invalid.id)
    expect(invalidFailure.data.error.message).toContain("Invalid token budget configuration")
    expect(count(provider, invalid.id)).toBe(0)
    scenario.evidence.reportingGap = {
      sessionID: reporting.id,
      providerRequests: count(provider, reporting.id),
      nextExecution: unknownBlocked.type,
      nextError: unknownBlocked.data.error,
    }
    scenario.evidence.invalidOptions = {
      sessionID: invalid.id,
      value: 0,
      providerRequests: count(provider, invalid.id),
      terminalEvent: invalidFailure.type,
      error: invalidFailure.data.error,
    }
  })
})

test("native cumulative usage remains monotonic across compaction and duplicate refreshes", async () => {
  await runScenario("native-compaction", async (scenario) => {
    const provider = await scenario.createProvider(() => completion(5, "compact summary"))
    const host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 1_000 }))
    const root = await createRoot(host, "Native usage survives compaction")
    await clientPrompt(host, root.id, "Record one reported response before compaction.")
    await host.waitForSuccess(root.id)
    const before = total((await host.client.session.get({ sessionID: root.id })).tokens)
    expect(before).toBe(5)
    expect(count(provider, root.id)).toBe(1)

    await command(host, root.id, "status")
    const first = parseStatus(await latestSynthetic(host, root.id))
    await command(host, root.id, "status")
    const duplicate = parseStatus(await latestSynthetic(host, root.id))
    expect(first.familyUsage).toBe(before)
    expect(duplicate.familyUsage).toBe(before)
    expect(count(provider, root.id)).toBe(1)

    await host.client.session.compact({ sessionID: root.id })
    await host.waitForSuccess(root.id)
    const after = total((await host.client.session.get({ sessionID: root.id })).tokens)
    expect(after).toBeGreaterThan(before)
    expect(count(provider, root.id)).toBeGreaterThan(1)
    await command(host, root.id, "status")
    const compacted = parseStatus(await latestSynthetic(host, root.id))
    expect(compacted.familyUsage).toBe(after)
    await command(host, root.id, "status")
    expect(parseStatus(await latestSynthetic(host, root.id)).familyUsage).toBe(after)

    scenario.evidence.nativeRefresh = {
      sessionID: root.id,
      usageBeforeCompaction: before,
      usageAfterCompaction: after,
      duplicateRefreshFamilyUsage: duplicate.familyUsage,
      providerRequests: count(provider, root.id),
    }
  })
})

test("a live shell/CI wait completes after a sibling reaches the boundary; only its next model request is blocked", async () => {
  await runScenario("in-flight-ci", async (scenario) => {
    const ciStarted = deferred<void>()
    const ciRelease = deferred<void>()
    let ciReleased = false
    let ciWasReached = false
    let rootSettled = false
    let rootID: string | undefined
    let host: RunningHost | undefined
    const ciServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== "/ci-wait") return new Response("Not found", { status: 404 })
        ciWasReached = true
        ciStarted.resolve(undefined)
        await ciRelease.promise
        return new Response("CI wait released", { status: 200 })
      },
    })
    let childOneID: string | undefined
    let childTwoID: string | undefined
    const provider = await scenario.createProvider((call) => {
      if (call.sessionID === rootID)
        return shellCall(`node -e 'fetch("${ciServer.url.origin}/ci-wait").then(async r => console.log(await r.text()))'`, 20)
      if (call.sessionID === childOneID) return completion(40, "first child completed")
      if (call.sessionID === childTwoID) return completion(20, "second child completed")
      return completion(1, "unexpected CI-family request")
    })
    host = await scenario.createHost(hostConfig(provider.origin, workspaceRoot, { tokenCeiling: 50 }))
    const root = await createRoot(host, "CI Session root")
    rootID = root.id
    scenario.onSettle(async () => {
      const shellWasRequested = provider.calls.some((call) => call.sessionID === root.id && call.toolNames.includes("shell"))
      if (shellWasRequested && !rootSettled) {
        if (!ciWasReached) await ciStarted.promise
        ciReleased = true
        ciRelease.resolve(undefined)
        await host?.waitForTerminal(root.id)
      } else if (!ciReleased) {
        ciReleased = true
        ciRelease.resolve(undefined)
      }
      ciServer.stop(true)
    })
    await clientPrompt(host, root.id, "Start one local CI check.")
    await ciStarted.promise

    const childOne = await createChild(host, root.id, "CI child one")
    childOneID = childOne.id
    await clientPrompt(host, childOne.id, "Use one reported local response.")
    await host.waitForSuccess(childOne.id)

    const childTwo = await createChild(host, root.id, "CI child two")
    childTwoID = childTwo.id
    await clientPrompt(host, childTwo.id, "Reach the shared reported-token boundary.")
    const childTwoTerminal = await host.waitForTerminal(childTwo.id)
    if (childTwoTerminal.type === "session.execution.succeeded") {
      await clientPrompt(host, childTwo.id, "Try one more turn while root CI is still running.")
      const secondChildBlock = await host.waitForFailure(childTwo.id, childTwoTerminal.durable.seq)
      expect(secondChildBlock.data.error.message).toContain("Token budget blocked:")
    } else {
      expect(childTwoTerminal.data.error.message).toContain("Token budget blocked:")
    }
    expect(ciReleased).toBe(false)
    expect(count(provider, childTwo.id)).toBe(childTwoTerminal.type === "session.execution.succeeded" ? 1 : 0)

    ciReleased = true
    ciRelease.resolve(undefined)
    const rootFailure = await host.waitForFailure(root.id)
    rootSettled = true
    expect(rootFailure.data.error.message).toContain("Token budget blocked:")
    const rootMessages = await host.client.session.context({ sessionID: root.id })
    const shellTool = rootMessages
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool" && part.name === "shell")
    if (!shellTool || shellTool.type !== "tool") throw new Error("The in-flight shell tool result was not preserved")
    expect(shellTool.state.status).toBe("completed")
    if (shellTool.state.status === "completed")
      expect(shellTool.state.content.some((part) => part.type === "text" && part.text.includes("CI wait released"))).toBe(true)
    expect(count(provider, root.id)).toBe(1)
    scenario.evidence.inFlight = {
      rootID: root.id,
      childOneID: childOne.id,
      childTwoID: childTwo.id,
      rootTerminal: rootFailure.type,
      childTwoTerminal: childTwoTerminal.type,
      shellToolPreserved: true,
      ciDeferredReleasedAfterBoundary: true,
      providerCalls: provider.calls,
    }
  })
})

interface Scenario {
  readonly root: string
  readonly runDir: string
  readonly runID: string
  readonly evidence: Record<string, unknown>
  readonly createProvider: (respond: (call: ProviderCall) => Response | Promise<Response>) => Promise<LocalProvider>
  readonly createHost: (config: unknown) => Promise<RunningHost>
  readonly onSettle: (settle: () => void | Promise<void>) => void
}

async function runScenario(name: string, run: (scenario: Scenario) => Promise<void>) {
  const canary = join(workspaceRoot, ".cache", "dev-env", "corrections-survival-canary.txt")
  await mkdir(dirname(canary), { recursive: true, mode: 0o700 })
  if (!(await Bun.file(canary).exists())) await writeFile(canary, "Production integration survival canary.\n", { mode: 0o600 })
  const canaryText = await readFile(canary, "utf8")
  const runRoot = join(workspaceRoot, ".cache", "dev-env", "corrections-runs")
  await mkdir(runRoot, { recursive: true, mode: 0o700 })
  const runDir = await mkdtemp(join(runRoot, `production-${name}-`))
  const runID = basename(runDir)
  const hosts: RunningHost[] = []
  const providers: LocalProvider[] = []
  const settle: Array<() => void | Promise<void>> = []
  const cleanupFailures: string[] = []
  const evidence: Record<string, unknown> = {
    scenario: name,
    runID,
    source: await sourceBinding(),
    toolchain: { bun: Bun.version, node: await nodeVersion() },
  }
  let failure: unknown
  try {
    await run({
      root: workspaceRoot,
      runDir,
      runID,
      evidence,
      createProvider: async (respond) => {
        const provider = await startProvider(respond)
        providers.push(provider)
        return provider
      },
      createHost: async (config) => {
        const host = await startHost({ workspaceRoot, runDir, config })
        hosts.push(host)
        return host
      },
      onSettle: (action) => settle.push(action),
    })
  } catch (error) {
    failure = error
  } finally {
    for (const action of settle) {
      try {
        await action()
      } catch (error) {
        cleanupFailures.push(`owned asynchronous work did not settle: ${errorText(error)}`)
      }
    }
    const hostReports: Array<{ host: RunningHost; report: HostReport }> = []
    for (const host of hosts.toReversed()) {
      try {
        hostReports.push({ host, report: await host.close() })
      } catch (error) {
        cleanupFailures.push(`host shutdown failed: ${errorText(error)}`)
      }
    }
    for (const provider of providers.toReversed()) {
      try {
        await provider.stop()
      } catch (error) {
        cleanupFailures.push(`loopback provider stop failed: ${errorText(error)}`)
      }
    }
    const artifactDir = join(workspaceRoot, "artifacts", "corrections")
    await mkdir(artifactDir, { recursive: true })
    for (const [index, hostReport] of hostReports.entries()) {
      const suffix = `${runID}-host-${index + 1}`
      await writeFile(join(artifactDir, `${suffix}.stdout.log`), sanitize(hostReport.report.stdout, workspaceRoot, runDir), { mode: 0o600 })
      await writeFile(join(artifactDir, `${suffix}.stderr.log`), sanitize(hostReport.report.stderr, workspaceRoot, runDir), { mode: 0o600 })
      await writeFile(join(artifactDir, `${suffix}.application.log`), sanitize(hostReport.report.applicationLog, workspaceRoot, runDir), { mode: 0o600 })
    }
    const failureText = failure === undefined ? undefined : sanitize(errorText(failure), workspaceRoot, runDir)
    const outcome = failureText || cleanupFailures.length > 0 || hostReports.some((hostReport) => !hostReport.report.closed) ? "failed" : "passed"
    const runtime = {
      ...evidence,
      outcome,
      failure: failureText,
      cleanupFailures,
      hosts: hostReports.map(({ host, report }, index) => ({
        version: host.version,
        binarySha256: host.binarySha256,
        nodeVersion: host.nodeVersion,
        exitCode: report.exitCode,
        processExited: true,
        listenerClosed: report.closed,
        logPrefix: `${runID}-host-${index + 1}`,
      })),
      providers: providers.map((provider) => ({
        origin: new URL(provider.origin).origin,
        requests: provider.calls,
      })),
      scratch: relative(workspaceRoot, runDir),
      survivalCanary: relative(workspaceRoot, canary),
      survivalCanaryPreserved: (await Bun.file(canary).exists()) && (await readFile(canary, "utf8")) === canaryText,
    }
    await writeFile(join(artifactDir, `runtime-${runID}.json`), `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 })
    if (outcome === "failed") {
      await writeFile(
        join(artifactDir, `failure-${runID}.json`),
        `${JSON.stringify({ runID, failure: failureText, cleanupFailures, scratch: relative(workspaceRoot, runDir) }, null, 2)}\n`,
        { mode: 0o600 },
      )
    } else {
      try {
        await rm(runDir, { recursive: true, force: true })
        if ((await readFile(canary, "utf8")) !== canaryText) cleanupFailures.push("survival canary changed during scratch cleanup")
      } catch (error) {
        cleanupFailures.push(`scratch cleanup failed: ${errorText(error)}`)
      }
    }
  }
  if (failure !== undefined) throw failure
  if (cleanupFailures.length > 0) throw new Error(cleanupFailures.join("; "))
}

async function createRoot(host: RunningHost, title: string) {
  return host.client.session.create({
    location: { directory: host.project },
    title,
    agent: "build",
    model: { id: modelID, providerID },
    permissions: permission,
  })
}

async function createChild(host: RunningHost, parentID: string, title: string) {
  return host.client.session.create({
    parentID,
    title,
    agent: "build",
    model: { id: modelID, providerID },
    permissions: permission,
  })
}

async function clientPrompt(host: RunningHost, sessionID: string, text: string) {
  await host.client.session.prompt({ sessionID, text })
}

async function command(host: RunningHost, sessionID: string, text: string) {
  await host.client.session.command({ sessionID, name: commandName, text })
}

async function latestSynthetic(host: RunningHost, sessionID: string) {
  const inbox = await host.client.session.inbox.list({ sessionID })
  const output = inbox.findLast((item) => item.type === "synthetic")
  if (!output || output.type !== "synthetic") throw new Error(`No static command response was recorded; inbox=${JSON.stringify(inbox)}`)
  return output.payload.text
}

function parseStatus(text: string) {
  const match = /Budget: family (\d+)\/(\d+); Session (\d+)(?:; local grant (\d+))?; remaining (\d+)/u.exec(text)
  if (!match) throw new Error(`Unexpected budget status output: ${text}`)
  return {
    familyUsage: Number(match[1]),
    base: Number(match[2]),
    sessionUsage: Number(match[3]),
    grantCeiling: match[4] === undefined ? undefined : Number(match[4]),
    remaining: Number(match[5]),
  }
}

function total(tokens: TokenUsage.Info | undefined) {
  if (!tokens) throw new Error("Native Session token usage was missing")
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function count(provider: LocalProvider, sessionID: string) {
  return provider.calls.filter((call) => call.sessionID === sessionID).length
}

function hostConfig(
  providerOrigin: string,
  pluginPath: string,
  options: Record<string, unknown> | undefined,
  additionalPlugins: ReadonlyArray<string> = [],
) {
  return {
    plugins: [
      ...(options === undefined ? [] : [{ package: pluginPath, options }]),
      ...additionalPlugins.map((packagePath) => ({ package: packagePath })),
    ],
    instructions: [],
    providers: {
      [providerID]: {
        name: "Production integration loopback provider",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `${providerOrigin}/v1`,
          apiKey: "integration-only-key",
          provider: "token-budget-production-test",
        },
        models: {
          [modelID]: {
            name: "Production integration fixture model",
            modelID,
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            limit: { context: 32_000, output: 1_024 },
          },
        },
      },
    },
  }
}

function completion(tokens: number, text: string, usage = true) {
  const id = "chatcmpl_token_budget_production"
  const chunks: Array<Record<string, unknown>> = [
    { id, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: null },
    { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }], usage: null },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
  ]
  if (usage)
    chunks.push({
      id,
      choices: [],
      usage: {
        prompt_tokens: Math.max(0, tokens - 1),
        completion_tokens: 1,
        total_tokens: tokens,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
  })
}

function shellCall(commandText: string, tokens: number) {
  const id = "chatcmpl_token_budget_ci"
  const chunks = [
    { id, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: null },
    {
      id,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_ci_wait",
                type: "function",
                function: { name: "shell", arguments: JSON.stringify({ command: commandText }) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: null },
    {
      id,
      choices: [],
      usage: {
        prompt_tokens: Math.max(0, tokens - 1),
        completion_tokens: 1,
        total_tokens: tokens,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
  })
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function sourceBinding() {
  const paths = [
    "src/budget.ts",
    "src/index.ts",
    "test/integration/fixtures/pre-send-reject-once/server.ts",
    "test/integration/production.test.ts",
    "test/portable/helpers/host.ts",
    "test/portable/helpers/terminal-events.ts",
    "test/unit/budget.test.ts",
    "test/unit/support/context.ts",
    "test/unit/terminal-events.test.ts",
  ]
  const files: Record<string, string> = {}
  for (const path of paths)
    files[path] = createHash("sha256").update(await readFile(join(workspaceRoot, path))).digest("hex")
  return { algorithm: "sha256", files }
}

async function nodeVersion() {
  const node = Bun.which("node")
  if (!node) throw new Error("Qualified Node 24.18.0 is required")
  const result = Bun.spawnSync([node, "--version"], { stdout: "pipe", stderr: "pipe" })
  const version = new TextDecoder().decode(result.stdout).trim()
  if (result.exitCode !== 0 || version !== "v24.18.0") throw new Error(`Unexpected Node version: ${version}`)
  return version
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
}

function sanitize(value: string, root: string, runDir: string) {
  return value.replaceAll(runDir, "<run>").replaceAll(root, "<workspace>")
}
