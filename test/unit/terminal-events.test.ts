import { expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createEventTracker } from "../portable/helpers/terminal-events"

type TerminalEvent = Extract<OpenCodeEvent, { type: "session.execution.failed" | "session.execution.succeeded" }>

test("a terminal event buffered before wait registration resolves once and is not reused", async () => {
  const tracker = createEventTracker()
  const first = succeeded("ses_terminal", 1)
  tracker.observe(first)

  let firstResult: TerminalEvent | undefined
  const firstWait = tracker.waitForTerminal("ses_terminal", undefined, isTerminal).then((event) => {
    firstResult = event
  })
  await Promise.resolve()
  expect(firstResult).toBe(first)
  await firstWait

  let nextResult: TerminalEvent | undefined
  const nextWait = tracker.waitForTerminal("ses_terminal", undefined, isTerminal).then((event) => {
    nextResult = event
  })
  tracker.observe(first)
  await Promise.resolve()
  expect(nextResult).toBeUndefined()

  const next = succeeded("ses_terminal", 2)
  tracker.observe(next)
  await nextWait
  expect(nextResult).toBe(next)
})

function isTerminal(event: OpenCodeEvent): event is TerminalEvent {
  return event.type === "session.execution.failed" || event.type === "session.execution.succeeded"
}

function succeeded(sessionID: string, sequence: number): TerminalEvent {
  return {
    id: `event_${sequence}`,
    created: sequence,
    type: "session.execution.succeeded",
    durable: { aggregateID: sessionID, seq: sequence, version: 1 },
    data: { sessionID },
  } as unknown as TerminalEvent
}
