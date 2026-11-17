import { Predicate } from "effect"
import type { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import type { TokenUsage } from "@opencode/schema/token-usage"

export const DEFAULT_TOKEN_CEILING = 40_000_000
export const BLOCKED_MESSAGE_PREFIX = "Token budget blocked:"

const STORAGE_KEY = "budget-state.v1"
const PROCESS_EPOCH = crypto.randomUUID()

export interface Grant {
  offset: number
  ceiling: number
}

interface Member {
  highWater: number
  baseline: number
  known: boolean
  pendingModelRequest?: true
  pendingStep?: true
}

interface Family {
  rootID: string
  base: number
  members: Record<string, Member>
  grants: Record<string, Grant>
  paused: Record<string, true>
  hasForks: boolean
  discoveryEpoch: string
  unavailable?: string
}

interface State {
  version: 1
  families: Record<string, Family>
}

export interface CeilingConfig {
  value?: number
  error?: string
}

export interface Snapshot {
  attached: boolean
  allowed: boolean
  reason?: "unattached" | "configuration" | "unavailable" | "manual-stop" | "ceiling" | "grant-consumed"
  message?: string
  familyID?: string
  base?: number
  familyUsage?: number
  sessionUsage?: number
  remaining?: number
  grant?: Grant
  manualStop: boolean
}

type Context = Plugin.Context
type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>

let transaction = Promise.resolve()

export function configuredCeiling(input: unknown): CeilingConfig {
  if (!Predicate.isObject(input)) return { error: "Plugin options must be an object." }
  const value = input.tokenCeiling
  if (value === undefined) return { value: DEFAULT_TOKEN_CEILING }
  if (!positiveSafeInteger(value)) return { error: "tokenCeiling must be a positive safe integer." }
  return { value }
}

export function parseStartCeiling(input: string): number | undefined {
  const value = input.trim()
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined
  const number = Number(value)
  return positiveSafeInteger(number) ? number : undefined
}

export function reportedTokens(tokens: TokenUsage.Info | undefined): number | undefined {
  if (!tokens) return undefined
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined
  const total = values.reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : undefined
}

export function monotonicHighWater(previous: number, observed: number) {
  return Math.max(previous, observed)
}

export function nextGrant(base: number, familyUsage: number, sessionUsage: number, previous?: Grant) {
  if (!positiveSafeInteger(base) || !Number.isSafeInteger(familyUsage) || !Number.isSafeInteger(sessionUsage))
    return undefined
  if (familyUsage < base || sessionUsage < 0 || sessionUsage > familyUsage) return undefined
  const ceiling = plus25(previous?.ceiling ?? base)
  if (ceiling === undefined) return undefined
  const offset = previous?.offset ?? familyUsage - sessionUsage
  if (!Number.isSafeInteger(offset) || offset < 0) return undefined
  return { offset, ceiling } satisfies Grant
}

export function grantRemaining(usage: number, grant?: Grant) {
  if (!grant) return 0
  return Math.max(0, grant.ceiling - grant.offset - usage)
}

export async function evaluate(ctx: Context, sessionID: string, ceiling: CeilingConfig): Promise<Snapshot> {
  return inspect(ctx, sessionID, ceiling, false, false)
}

export async function admit(
  ctx: Context,
  sessionID: string,
  ceiling: CeilingConfig,
  trackPendingWork = true,
): Promise<Snapshot> {
  return inspect(ctx, sessionID, ceiling, true, trackPendingWork)
}

async function inspect(
  ctx: Context,
  sessionID: string,
  ceiling: CeilingConfig,
  modelRequest: boolean,
  trackPendingWork: boolean,
): Promise<Snapshot> {
  return locked(async () => {
    const state = await readState(ctx)
    const info = await ctx.session.get({ sessionID })
    const lineage = await lineageFor(ctx, info, state)
    const family = await findOrCreate(ctx, state, info, lineage, ceiling)
    if (!family) {
      await writeState(ctx, state)
      return unattached(sessionID, ceiling.error)
    }
    await reconcile(ctx, state, family, info, lineage)
    const member = family.members[sessionID]
    const snapshot = snapshotFor(family, sessionID)
    if (modelRequest && trackPendingWork && member && snapshot.allowed) member.pendingModelRequest = true
    await writeState(ctx, state)
    return snapshot
  })
}

export async function status(ctx: Context, sessionID: string, ceiling: CeilingConfig): Promise<Snapshot> {
  return evaluate(ctx, sessionID, ceiling)
}

export async function attach(ctx: Context, sessionID: string, base: number): Promise<Snapshot> {
  return locked(async () => {
    const state = await readState(ctx)
    const info = await ctx.session.get({ sessionID })
    const lineage = await lineageFor(ctx, info, state)
    const all = await listAll(ctx)
    const component = connected(all, info.id, lineage)
    const existing = findFamily(state, component.map((item) => item.id))
    if (existing) {
      await writeState(ctx, state)
      return { ...snapshotFor(existing, sessionID), allowed: false, reason: "configuration", message: "A budget is already attached to this Session family; start does not replace it." }
    }
    const root = rootOf(component)
    const family = createFamily(root, base, component, true)
    state.families[family.rootID] = family
    await writeState(ctx, state)
    return snapshotFor(family, sessionID)
  })
}

export async function grant(ctx: Context, sessionID: string, ceiling: CeilingConfig): Promise<Snapshot> {
  return locked(async () => {
    const state = await readState(ctx)
    const info = await ctx.session.get({ sessionID })
    const lineage = await lineageFor(ctx, info, state)
    const family = await findOrCreate(ctx, state, info, lineage, ceiling)
    if (!family) return unattached(sessionID, ceiling.error)
    await reconcile(ctx, state, family, info, lineage)
    const before = snapshotFor(family, sessionID)
    if (before.allowed || (before.reason !== "ceiling" && before.reason !== "grant-consumed")) {
      await writeState(ctx, state)
      return {
        ...before,
        allowed: false,
        reason: "configuration",
        message: before.reason === "unavailable"
          ? before.message
          : "A +25% grant is available only when this Session is blocked by its family budget.",
      }
    }
    const member = family.members[sessionID]
    if (!member) return unavailableSnapshot(family, sessionID, "The selected Session is not in the stored family.")
    const grant = nextGrant(family.base, before.familyUsage ?? 0, countedUsage(member), family.grants[sessionID])
    if (!grant) {
      await writeState(ctx, state)
      return { ...before, allowed: false, reason: "configuration", message: "The next +25% ceiling would exceed the safe-integer range." }
    }
    family.grants[sessionID] = grant
    const after = snapshotFor(family, sessionID)
    await writeState(ctx, state)
    return after
  })
}

export async function continueSession(ctx: Context, sessionID: string, ceiling: CeilingConfig): Promise<Snapshot> {
  return locked(async () => {
    const state = await readState(ctx)
    const info = await ctx.session.get({ sessionID })
    const lineage = await lineageFor(ctx, info, state)
    const family = await findOrCreate(ctx, state, info, lineage, ceiling)
    if (!family) return unattached(sessionID, ceiling.error)
    await reconcile(ctx, state, family, info, lineage)
    delete family.paused[sessionID]
    let before = snapshotFor(family, sessionID)
    if (!before.allowed && (before.reason === "ceiling" || before.reason === "grant-consumed")) {
      const member = family.members[sessionID]
      const grant = member && nextGrant(family.base, before.familyUsage ?? 0, countedUsage(member), family.grants[sessionID])
      if (grant) family.grants[sessionID] = grant
      else {
        await writeState(ctx, state)
        return { ...before, allowed: false, reason: "configuration", message: "The next +25% ceiling would exceed the safe-integer range." }
      }
      before = snapshotFor(family, sessionID)
    }
    await writeState(ctx, state)
    return before
  })
}

export async function stop(ctx: Context, sessionID: string, ceiling: CeilingConfig): Promise<Snapshot> {
  return locked(async () => {
    const state = await readState(ctx)
    const info = await ctx.session.get({ sessionID })
    const lineage = await lineageFor(ctx, info, state)
    const family = await findOrCreate(ctx, state, info, lineage, ceiling)
    if (!family) return unattached(sessionID, ceiling.error)
    await reconcile(ctx, state, family, info, lineage)
    family.paused[sessionID] = true
    const snapshot = snapshotFor(family, sessionID)
    await writeState(ctx, state)
    return snapshot
  })
}

export async function markStepStarted(ctx: Context, sessionID: string): Promise<void> {
  await locked(async () => {
    const state = await readState(ctx)
    const family = findFamily(state, [sessionID])
    if (!family) return
    const member = family.members[sessionID]
    if (!member) {
      family.unavailable ??= `A model step started for an untracked family member (${sessionID}).`
      await writeState(ctx, state)
      return
    }
    member.pendingModelRequest = true
    member.pendingStep = true
    await writeState(ctx, state)
  })
}

export async function recordStepCompletion(
  ctx: Context,
  sessionID: string,
  tokens: TokenUsage.Info | undefined,
): Promise<void> {
  await locked(async () => {
    const state = await readState(ctx)
    const family = findFamily(state, [sessionID])
    if (!family) return
    const member = family.members[sessionID]
    if (!member) {
      family.unavailable ??= `A completed model step could not be matched to a stored family member (${sessionID}).`
      await writeState(ctx, state)
      return
    }
    delete member.pendingModelRequest
    delete member.pendingStep
    const stepUsage = reportedTokens(tokens)
    if (stepUsage === undefined || stepUsage === 0) {
      member.known = false
      family.unavailable ??= "A completed model step did not report usable tokens."
      await writeState(ctx, state)
      return
    }
    try {
      const info = await ctx.session.get({ sessionID })
      const usage = reportedTokens(info.tokens)
      if (usage === undefined) {
        member.known = false
        family.unavailable ??= "The Session cumulative usage is not safely reportable after a completed model step."
      } else if (usage < member.highWater) {
        member.known = false
        family.unavailable ??= "The Session cumulative usage decreased after a completed model step."
      } else member.highWater = monotonicHighWater(member.highWater, usage)
    } catch (error) {
      member.known = false
      family.unavailable ??= `Completed Session usage could not be refreshed (${sessionID}): ${errorMessage(error)}`
    }
    await writeState(ctx, state)
  })
}

export async function markExecutionTerminal(ctx: Context, sessionID: string): Promise<void> {
  await locked(async () => {
    const state = await readState(ctx)
    const family = findFamily(state, [sessionID])
    const member = family?.members[sessionID]
    if (!family || !member) return
    if (member.pendingStep) {
      member.known = false
      family.unavailable ??= "A started model step ended without a usable completion report."
    }
    delete member.pendingModelRequest
    delete member.pendingStep
    await writeState(ctx, state)
  })
}

export async function markFork(ctx: Context, sourceSessionID: string, forkSessionID: string): Promise<void> {
  await locked(async () => {
    const state = await readState(ctx)
    const family = findFamily(state, [sourceSessionID])
    if (!family) return
    family.hasForks = true
    if (!family.members[forkSessionID])
      family.members[forkSessionID] = { highWater: 0, baseline: 0, known: true }
    await writeState(ctx, state)
  })
}

export async function markAllUnavailable(ctx: Context, reason: string): Promise<void> {
  await locked(async () => {
    const state = await readState(ctx)
    for (const family of Object.values(state.families)) family.unavailable ??= reason
    await writeState(ctx, state)
  })
}

export function statusMessage(snapshot: Snapshot) {
  if (!snapshot.attached) return snapshot.message ?? "Token budget is not attached to this Session family. Use /budget start <tokens>."
  const family = snapshot.familyUsage === undefined ? "unknown" : String(snapshot.familyUsage)
  const session = snapshot.sessionUsage === undefined ? "unknown" : String(snapshot.sessionUsage)
  if (snapshot.reason === "unavailable")
    return `${BLOCKED_MESSAGE_PREFIX} usage accounting is unavailable; this family fails closed. ${snapshot.message ?? ""}`.trim()
  if (snapshot.grant)
    return `Budget: family ${family}/${snapshot.base}; Session ${session}; local grant ${snapshot.grant.ceiling}; remaining ${snapshot.remaining}; ${snapshot.allowed ? "active" : "blocked"}.`
  if (snapshot.allowed) return `Budget: family ${family}/${snapshot.base}; Session ${session}; remaining ${snapshot.remaining}.`
  if (snapshot.reason === "manual-stop")
    return `${BLOCKED_MESSAGE_PREFIX} this Session is manually paused. Family usage ${family}/${snapshot.base}; remaining ${snapshot.remaining}. Use /budget continue.`
  return `${BLOCKED_MESSAGE_PREFIX} family usage ${family}/${snapshot.base}; Session ${session}; remaining ${snapshot.remaining}. Use /budget +25% on the selected Session.`
}

export function denialMessage(snapshot: Snapshot) {
  if (snapshot.reason === "unattached") return `${BLOCKED_MESSAGE_PREFIX} this existing family is not attached. Use /budget start <tokens>.`
  if (snapshot.reason === "configuration")
    return `${BLOCKED_MESSAGE_PREFIX} ${snapshot.message ?? "token ceiling configuration is invalid."}`
  if (snapshot.reason === "unavailable")
    return `${BLOCKED_MESSAGE_PREFIX} usage accounting is unavailable; generation is paused. ${snapshot.message ?? ""}`.trim()
  if (snapshot.reason === "manual-stop") return `${BLOCKED_MESSAGE_PREFIX} this Session is manually paused. Use /budget continue.`
  if (snapshot.reason === "grant-consumed") return `${BLOCKED_MESSAGE_PREFIX} this Session's local grant is consumed.`
  if (snapshot.message) return `${BLOCKED_MESSAGE_PREFIX} ${snapshot.message}`
  return `${BLOCKED_MESSAGE_PREFIX} the family ceiling is reached.`
}

export function isBudgetMessage(message: string) {
  return message.startsWith(BLOCKED_MESSAGE_PREFIX)
}

function positiveSafeInteger(value: unknown): value is number {
  return Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0
}

function plus25(value: number) {
  const next = (BigInt(value) * 5n + 3n) / 4n
  if (next > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(next)
}

async function findOrCreate(
  ctx: Context,
  state: State,
  current: SessionInfo,
  lineage: ReadonlyArray<SessionInfo>,
  ceiling: CeilingConfig,
) {
  const lineageIDs = lineage.map((item) => item.id)
  const family = findFamily(state, lineageIDs)
  if (family) return family
  const root = lineage.at(-1) ?? current
  const hasRootHistory = root.time.idle !== undefined || reportedTokens(root.tokens) !== 0
  if (root.parentID || root.fork || hasRootHistory) return undefined
  if (ceiling.error || ceiling.value === undefined) return undefined
  const all = await listAll(ctx)
  const component = connected(all, root.id, lineage)
  const discovered = findFamily(state, component.map((item) => item.id))
  if (discovered) return discovered
  const created = createFamily(root.id, ceiling.value, component)
  state.families[created.rootID] = created
  return created
}

async function reconcile(
  ctx: Context,
  state: State,
  family: Family,
  current: SessionInfo,
  lineage: ReadonlyArray<SessionInfo>,
) {
  const memberIDs = Object.keys(family.members)
  const seeds = [...new Set([...memberIDs, ...lineage.map((info) => info.id)])]
  const needsFullScan = family.discoveryEpoch !== PROCESS_EPOCH || family.hasForks || lineage.some((info) => info.fork)
  const memberInfos = new Map(lineage.map((info) => [info.id, info]))
  for (const id of memberIDs) {
    if (memberInfos.has(id)) continue
    try {
      const info = await ctx.session.get({ sessionID: id })
      memberInfos.set(info.id, info)
    } catch (error) {
      const member = family.members[id]
      if (isNotFound(error)) {
        if (member?.pendingModelRequest || member?.pendingStep) {
          member.known = false
          delete member.pendingModelRequest
          delete member.pendingStep
          family.unavailable ??= `Session ${id} with unresolved model work was deleted; usage is unavailable.`
        }
        continue
      }
      if (member) member.known = false
      if (member) {
        delete member.pendingModelRequest
        delete member.pendingStep
      }
      family.unavailable ??= `Session usage could not be refreshed (${id}): ${errorMessage(error)}`
    }
  }
  let related = await descendants(ctx, [...memberInfos.values()], seeds)
  if (needsFullScan || related.some((info) => info.fork))
    related = connected(await listAll(ctx), current.id, related, memberIDs)
  family.hasForks ||= related.some((info) => info.fork !== undefined)
  for (const info of related) mergeMember(family, info)
  family.discoveryEpoch = PROCESS_EPOCH
}

function createFamily(rootID: string, base: number, members: ReadonlyArray<SessionInfo>, baselineAtCurrentUsage = false): Family {
  const family: Family = {
    rootID,
    base,
    members: {},
    grants: {},
    paused: {},
    hasForks: members.some((info) => info.fork !== undefined),
    discoveryEpoch: PROCESS_EPOCH,
  }
  for (const info of members) {
    const usage = reportedTokens(info.tokens)
    family.members[info.id] = {
      highWater: usage ?? 0,
      baseline: baselineAtCurrentUsage ? usage ?? 0 : 0,
      known: usage !== undefined,
    }
  }
  return family
}

function mergeMember(family: Family, info: SessionInfo) {
  const usage = reportedTokens(info.tokens)
  const previous = family.members[info.id]
  if (!previous) {
    family.members[info.id] = {
      highWater: usage ?? 0,
      baseline: 0,
      known: usage !== undefined,
    }
    return
  }
  if (usage === undefined) previous.known = false
  if (usage !== undefined) previous.highWater = monotonicHighWater(previous.highWater, usage)
}

function snapshotFor(family: Family, sessionID: string): Snapshot {
  const members = Object.values(family.members)
  let familyUsage = 0
  let known = family.unavailable === undefined && members.every((member) => member.known)
  for (const member of members) {
    familyUsage += countedUsage(member)
    if (!Number.isSafeInteger(familyUsage)) known = false
  }
  const member = family.members[sessionID]
  if (!member) known = false
  const sessionUsage = member ? countedUsage(member) : undefined
  const grant = family.grants[sessionID]
  const manualStop = family.paused[sessionID] === true
  if (!known) return { attached: true, allowed: false, reason: "unavailable", message: family.unavailable, familyID: family.rootID, base: family.base, familyUsage, sessionUsage, remaining: undefined, grant, manualStop }
  if (manualStop) return { attached: true, allowed: false, reason: "manual-stop", familyID: family.rootID, base: family.base, familyUsage, sessionUsage, remaining: grant ? grantRemaining(sessionUsage ?? 0, grant) : Math.max(0, family.base - familyUsage), grant, manualStop }
  if (familyUsage < family.base)
    return { attached: true, allowed: true, familyID: family.rootID, base: family.base, familyUsage, sessionUsage, remaining: Math.max(0, family.base - familyUsage), grant, manualStop }
  if (grant && sessionUsage !== undefined && sessionUsage + grant.offset < grant.ceiling)
    return { attached: true, allowed: true, familyID: family.rootID, base: family.base, familyUsage, sessionUsage, remaining: grantRemaining(sessionUsage, grant), grant, manualStop }
  return {
    attached: true,
    allowed: false,
    reason: grant ? "grant-consumed" : "ceiling",
    familyID: family.rootID,
    base: family.base,
    familyUsage,
    sessionUsage,
    remaining: grant ? grantRemaining(sessionUsage ?? 0, grant) : 0,
    grant,
    manualStop,
  }
}

function countedUsage(member: Member) {
  return Math.max(0, member.highWater - member.baseline)
}

function unavailableSnapshot(family: Family, sessionID: string, message: string): Snapshot {
  const member = family.members[sessionID]
  return {
    attached: true,
    allowed: false,
    reason: "unavailable",
    message,
    familyID: family.rootID,
    sessionUsage: member ? countedUsage(member) : undefined,
    manualStop: false,
  }
}

function unattached(sessionID: string, configurationError?: string): Snapshot {
  if (configurationError)
    return { attached: false, allowed: false, reason: "configuration", message: `Invalid token budget configuration: ${configurationError}`, manualStop: false }
  return { attached: false, allowed: false, reason: "unattached", message: `Session ${sessionID} is not attached to a budget family. Use /budget start <tokens>.`, manualStop: false }
}

function findFamily(state: State, sessionIDs: ReadonlyArray<string>) {
  const ids = new Set(sessionIDs)
  const matches = Object.values(state.families).filter((family) => ids.has(family.rootID) || Array.from(ids).some((id) => Object.hasOwn(family.members, id)))
  if (matches.length > 1) throw new Error("Budget family links are ambiguous; generation is paused for safety.")
  return matches[0]
}

async function lineageFor(ctx: Context, current: SessionInfo, state: State) {
  const found = new Map<string, SessionInfo>([[current.id, current]])
  const queue = [current]
  const seen = new Set<string>([current.id])
  while (queue.length > 0) {
    const info = queue.shift()
    if (!info) continue
    const related = [info.parentID, info.fork?.sessionID].filter((id): id is string => id !== undefined)
    for (const id of related) {
      if (seen.has(id)) continue
      seen.add(id)
      try {
        const parent = await ctx.session.get({ sessionID: id })
        found.set(parent.id, parent)
        queue.push(parent)
      } catch (error) {
        if (!findFamily(state, [id])) throw new Error(`Cannot read Session family ancestor ${id}: ${errorMessage(error)}`)
      }
    }
  }
  return [...found.values()]
}

async function listAll(ctx: Context) {
  const output: SessionInfo[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const page = await ctx.session.list({ limit: 100, order: "asc", cursor })
    output.push(...page.data)
    const next = page.cursor.next ?? undefined
    if (!next || cursors.has(next)) return output
    cursors.add(next)
    cursor = next
  }
}

async function listChildren(ctx: Context, parentID: string) {
  const output: SessionInfo[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const page = await ctx.session.list({ parentID, limit: 100, order: "asc", cursor })
    output.push(...page.data)
    const next = page.cursor.next ?? undefined
    if (!next || cursors.has(next)) return output
    cursors.add(next)
    cursor = next
  }
}

async function descendants(ctx: Context, initial: ReadonlyArray<SessionInfo>, seedIDs: ReadonlyArray<string>) {
  const infos = new Map(initial.map((info) => [info.id, info]))
  const queue = [...new Set([...seedIDs, ...initial.map((info) => info.id)])]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const parentID = queue.shift()
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    for (const child of await listChildren(ctx, parentID)) {
      if (!infos.has(child.id)) queue.push(child.id)
      infos.set(child.id, child)
    }
  }
  return [...infos.values()]
}

function connected(
  all: ReadonlyArray<SessionInfo>,
  target: string,
  extra: ReadonlyArray<SessionInfo>,
  extraIDs: ReadonlyArray<string> = [],
) {
  const byID = new Map<string, SessionInfo>(all.map((info) => [info.id, info]))
  for (const info of extra) byID.set(info.id, info)
  const links = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!links.has(a)) links.set(a, new Set())
    if (!links.has(b)) links.set(b, new Set())
    links.get(a)?.add(b)
    links.get(b)?.add(a)
  }
  for (const info of byID.values()) {
    if (info.parentID) link(info.id, info.parentID)
    if (info.fork) link(info.id, info.fork.sessionID)
  }
  const seeds = [...new Set([target, ...extraIDs, ...extra.map((info) => info.id)])]
  const ids = new Set<string>(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    const id = queue.shift()
    if (!id) continue
    for (const related of links.get(id) ?? []) {
      if (ids.has(related)) continue
      ids.add(related)
      queue.push(related)
    }
  }
  return [...ids].flatMap((id) => {
    const info = byID.get(id)
    return info ? [info] : []
  })
}

function rootOf(component: ReadonlyArray<SessionInfo>) {
  const roots = component.filter((info) => !info.parentID && !info.fork)
  const candidate = roots.toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))[0] ?? component[0]
  if (!candidate) throw new Error("Cannot attach an empty Session family")
  return candidate.id
}

async function readState(ctx: Context): Promise<State> {
  const raw: unknown = await ctx.storage.get(STORAGE_KEY)
  if (raw === undefined) return { version: 1, families: {} }
  if (!Predicate.isObject(raw) || raw.version !== 1 || !Predicate.isObject(raw.families))
    throw new Error("Stored token budget state is invalid; generation is paused.")
  const families: Record<string, Family> = {}
  for (const [id, value] of Object.entries(raw.families)) {
    const family = decodeFamily(value)
    if (family.rootID !== id) throw new Error("Stored token budget family key does not match its root Session ID.")
    families[id] = family
  }
  return { version: 1, families }
}

function decodeFamily(input: unknown): Family {
  if (
    !Predicate.isObject(input) ||
    !Predicate.isString(input.rootID) ||
    !positiveSafeInteger(input.base) ||
    !Predicate.isObject(input.members) ||
    !Predicate.isObject(input.grants) ||
    !Predicate.isObject(input.paused)
  )
    throw new Error("Stored token budget family is invalid; generation is paused.")
  const members: Record<string, Member> = {}
  for (const [id, value] of Object.entries(input.members)) {
    if (
      !Predicate.isObject(value) ||
      !Predicate.isNumber(value.highWater) ||
      !Number.isSafeInteger(value.highWater) ||
      !Predicate.isBoolean(value.known)
    )
      throw new Error("Stored token budget high-water mark is invalid; generation is paused.")
    const baseline = value.baseline === undefined ? 0 : value.baseline
    if (!Predicate.isNumber(baseline) || !Number.isSafeInteger(baseline) || baseline < 0)
      throw new Error("Stored token budget baseline is invalid; generation is paused.")
    members[id] = {
      highWater: value.highWater,
      baseline,
      known: value.known,
      ...(value.pendingModelRequest === true ? { pendingModelRequest: true } : {}),
      ...(value.pendingStep === true ? { pendingStep: true } : {}),
    }
  }
  const grants: Record<string, Grant> = {}
  for (const [id, value] of Object.entries(input.grants)) {
    if (
      !Predicate.isObject(value) ||
      !Predicate.isNumber(value.offset) ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      !positiveSafeInteger(value.ceiling)
    )
      throw new Error("Stored token budget grant is invalid; generation is paused.")
    grants[id] = { offset: value.offset as number, ceiling: value.ceiling }
  }
  const paused: Record<string, true> = {}
  for (const [id, value] of Object.entries(input.paused)) {
    if (value === true) paused[id] = true
  }
  return {
    rootID: input.rootID,
    base: input.base,
    members,
    grants,
    paused,
    hasForks: input.hasForks === true,
    discoveryEpoch: typeof input.discoveryEpoch === "string" ? input.discoveryEpoch : "",
    ...(Predicate.isString(input.unavailable) ? { unavailable: input.unavailable } : {}),
  }
}

async function writeState(ctx: Context, state: State) {
  const families: Record<string, Schema.Json> = {}
  for (const [familyID, family] of Object.entries(state.families)) {
    const members: Record<string, Schema.Json> = {}
    for (const [sessionID, member] of Object.entries(family.members)) {
      members[sessionID] = {
        highWater: member.highWater,
        baseline: member.baseline,
        known: member.known,
        ...(member.pendingModelRequest ? { pendingModelRequest: true } : {}),
        ...(member.pendingStep ? { pendingStep: true } : {}),
      }
    }
    const grants: Record<string, Schema.Json> = {}
    for (const [sessionID, grant] of Object.entries(family.grants))
      grants[sessionID] = { offset: grant.offset, ceiling: grant.ceiling }
    const paused: Record<string, Schema.Json> = {}
    for (const sessionID of Object.keys(family.paused)) paused[sessionID] = true
    families[familyID] = {
      rootID: family.rootID,
      base: family.base,
      members,
      grants,
      paused,
      hasForks: family.hasForks,
      discoveryEpoch: family.discoveryEpoch,
      ...(family.unavailable === undefined ? {} : { unavailable: family.unavailable }),
    }
  }
  const json: Schema.Json = {
    version: 1,
    families,
  }
  await ctx.storage.set(STORAGE_KEY, json)
}

function isNotFound(error: unknown) {
  return error instanceof Error && /not found|\b404\b/iu.test(error.message)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function locked<Result>(operation: () => Promise<Result>): Promise<Result> {
  const result = transaction.then(operation, operation)
  transaction = result.then(() => undefined, () => undefined)
  return result
}
