import { Plugin } from "@opencode/plugin"
import type { Session } from "@opencode/schema/session"
import {
  admit,
  attach,
  configuredCeiling,
  continueSession,
  denialMessage,
  evaluate,
  grant,
  isBudgetMessage,
  markAllUnavailable,
  markExecutionTerminal,
  markFork,
  markStepStarted,
  parseStartCeiling,
  recordStepCompletion,
  status,
  statusMessage,
  stop,
} from "./budget"

const pluginID = "opencode.token-budget"
const commandName = "budget"

export default Plugin.define({
  id: pluginID,
  async setup(ctx) {
    const options: unknown = ctx.options
    const ceiling = configuredCeiling(options)

    await ctx.session.hook("model.request", async (event) => {
      const state = await admit(ctx, event.sessionID, ceiling, event.kind === "primary")
      if (!state.allowed) throw new Error(denialMessage(state))
    })

    await ctx.session.hook("retry", async (event) => {
      if (isBudgetMessage(event.error.message)) {
        event.decision = { retry: false }
        return
      }
      try {
        const state = await evaluate(ctx, event.sessionID, ceiling)
        if (!state.allowed) event.decision = { retry: false }
      } catch {
        event.decision = { retry: false }
      }
    })

    await ctx.command.transform((editor) =>
      editor.add({
        name: commandName,
        description: "Inspect, attach, grant, continue, or stop a Session token budget.",
        execute: async (input) => {
          const text = input.prompt.text.trim().replace(/^\/?budget(?:\s+|$)/iu, "").trim()
          const [action = "", ...arguments_] = text.split(/\s+/u)
          const sessionID = input.sessionID

          if (action === "status" && arguments_.length === 0) {
            const state = await status(ctx, sessionID, ceiling)
            await acknowledge(ctx, sessionID, state.message ?? statusMessage(state), "Token budget status")
            return
          }

          if (action === "start" && arguments_.length === 1) {
            const base = parseStartCeiling(arguments_[0] ?? "")
            if (base === undefined) {
              await acknowledge(ctx, sessionID, "Usage: /budget start <positive safe integer>.", "Token budget command")
              return
            }
            const state = await attach(ctx, sessionID, base)
            await acknowledge(ctx, sessionID, state.message ?? statusMessage(state), "Token budget attached")
            return
          }

          if (action === "+25%" && arguments_.length === 0) {
            const state = await grant(ctx, sessionID, ceiling)
            const message = state.allowed && state.grant
              ? `+25% granted to this Session only. Local remaining allowance: ${state.remaining}.`
              : state.message ?? statusMessage(state)
            await acknowledge(ctx, sessionID, message, "Session-local token budget grant")
            return
          }

          if (action === "continue") {
            const state = await continueSession(ctx, sessionID, ceiling)
            if (!state.allowed) {
              await acknowledge(ctx, sessionID, state.message ?? statusMessage(state), "Token budget remains paused")
              return
            }
            await ctx.session.prompt({
              sessionID,
              text: arguments_.join(" ").trim() || "Continue the requested work.",
              delivery: input.delivery,
            })
            return
          }

          if (action === "stop" && arguments_.length === 0) {
            const state = await stop(ctx, sessionID, ceiling)
            if (!state.attached) {
              await acknowledge(ctx, sessionID, state.message ?? statusMessage(state), "Token budget not attached")
              return
            }
            const interrupted = await ctx.session.interrupt({ sessionID, resume: false })
            const message = interrupted.interrupted
              ? "Budget paused by your request; the active Session execution was interrupted by that request."
              : "Budget paused by your request. No active Session execution needed interruption."
            await acknowledge(ctx, sessionID, message, "Manual token budget stop")
            return
          }

          await acknowledge(
            ctx,
            sessionID,
            "Usage: /budget status | /budget start <tokens> | /budget +25% | /budget continue | /budget stop",
            "Token budget command help",
          )
        },
      }),
    )

    const controller = new AbortController()
    const observer = observeUsage(ctx, controller.signal).catch(async (error: unknown) => {
      if (!controller.signal.aborted)
        await markAllUnavailable(ctx, `Session usage event observer failed: ${errorMessage(error)}`)
    })
    return async () => {
      controller.abort()
      await observer
    }
  },
})

async function observeUsage(ctx: Plugin.Context, signal: AbortSignal) {
  for await (const event of ctx.event.subscribe({
    types: [
      "session.step.started",
      "session.step.ended",
      "session.step.failed",
      "session.forked",
      "session.execution.failed",
      "session.execution.succeeded",
      "session.execution.interrupted",
    ],
    signal,
  })) {
    if (event.type === "session.forked") {
      await markFork(ctx, event.data.parentID, event.data.sessionID)
      continue
    }
    if (event.type === "session.step.started") {
      await markStepStarted(ctx, event.data.sessionID)
      continue
    }
    if (
      event.type === "session.execution.failed" ||
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.interrupted"
    ) {
      await markExecutionTerminal(ctx, event.data.sessionID)
      continue
    }
    await recordStepCompletion(ctx, event.data.sessionID, event.data.tokens)
  }
}

async function acknowledge(
  ctx: Plugin.Context,
  sessionID: Session.ID,
  text: string,
  description: string,
) {
  await ctx.session.synthetic({ sessionID, text, description, resume: false })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
