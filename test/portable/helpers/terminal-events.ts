import type { OpenCodeEvent } from "@opencode/client"

type TerminalEvent = Extract<OpenCodeEvent, { type: "session.execution.failed" | "session.execution.succeeded" }>
type Waiter = {
  readonly predicate: (event: OpenCodeEvent) => boolean
  readonly resolve: (event: OpenCodeEvent) => void
  readonly reject: (error: unknown) => void
}

export function createEventTracker() {
  const observed: OpenCodeEvent[] = []
  const consumedCursors = new Map<string, number>()
  const waiters: Waiter[] = []
  let streamError: unknown

  const waitFor = <Event extends OpenCodeEvent>(predicate: (event: OpenCodeEvent) => event is Event): Promise<Event> => {
    const previous = observed.find(predicate)
    if (previous) return Promise.resolve(previous)
    if (streamError !== undefined) return Promise.reject(streamError)
    return new Promise<Event>((resolveEvent, rejectEvent) => {
      waiters.push({
        predicate: (event) => predicate(event),
        resolve: (event) => {
          if (predicate(event)) resolveEvent(event)
        },
        reject: rejectEvent,
      })
    })
  }

  const waitForTerminal = <Event extends TerminalEvent>(
    sessionID: string,
    afterSequence: number | undefined,
    predicate: (event: OpenCodeEvent) => event is Event,
  ) => {
    const matches = (event: OpenCodeEvent): event is Event =>
      predicate(event) && event.durable.seq > Math.max(afterSequence ?? 0, consumedCursors.get(sessionID) ?? 0)
    const previous = observed.find(matches)
    if (previous) {
      consumedCursors.set(sessionID, previous.durable.seq)
      return Promise.resolve(previous)
    }
    if (streamError !== undefined) return Promise.reject(streamError)
    return new Promise<Event>((resolveEvent, rejectEvent) => {
      waiters.push({
        predicate: matches,
        resolve: (event) => {
          if (!matches(event)) return
          consumedCursors.set(sessionID, event.durable.seq)
          resolveEvent(event)
        },
        reject: rejectEvent,
      })
    })
  }

  return {
    observe(event: OpenCodeEvent) {
      observed.push(event)
      for (const waiter of waiters.slice()) {
        if (!waiter.predicate(event)) continue
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(event)
      }
    },
    fail(error: unknown) {
      streamError = error
      for (const waiter of waiters.splice(0)) waiter.reject(error)
    },
    waitFor,
    waitForTerminal,
  }
}
