import type { Plugin } from "@opencode/plugin"

type Context = Plugin.Context
type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>

export function tokenUsage(total: number) {
  return { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

export function sessionInfo(input: {
  id: string
  parentID?: string
  tokens?: number
  idle?: number
}): SessionInfo {
  return {
    id: input.id,
    ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    projectID: "prj_fixture",
    cost: 0,
    tokens: tokenUsage(input.tokens ?? 0),
    time: {
      created: 1,
      updated: 1,
      ...(input.idle === undefined ? {} : { idle: input.idle }),
    },
    location: { directory: "/workspace" },
  } as unknown as SessionInfo
}

export function memoryContext(initial: ReadonlyArray<SessionInfo>) {
  const sessions = new Map(initial.map((info) => [info.id, info]))
  const storage = new Map<string, unknown>()
  const ctx = {
    session: {
      async get(input: { readonly sessionID: string }) {
        const info = sessions.get(input.sessionID)
        if (!info) throw new Error(`Session not found: ${input.sessionID}`)
        return info
      },
      async list(input: { readonly parentID?: string | null }) {
        return {
          data: [...sessions.values()].filter((info) =>
            input.parentID === undefined ? true : input.parentID === null ? info.parentID === undefined : info.parentID === input.parentID,
          ),
          cursor: { next: undefined, previous: undefined },
        }
      },
    },
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async set(key: string, value: unknown) {
        storage.set(key, value)
      },
    },
  } as unknown as Context

  return {
    ctx,
    add(info: SessionInfo) {
      sessions.set(info.id, info)
    },
    updateUsage(sessionID: string, total: number) {
      const info = sessions.get(sessionID)
      if (!info) throw new Error(`Session not found: ${sessionID}`)
      sessions.set(sessionID, { ...info, tokens: tokenUsage(total) })
    },
    updateIdle(sessionID: string, idle: number) {
      const info = sessions.get(sessionID)
      if (!info) throw new Error(`Session not found: ${sessionID}`)
      sessions.set(sessionID, { ...info, time: { ...info.time, idle } })
    },
    remove(sessionID: string) {
      sessions.delete(sessionID)
    },
  }
}
