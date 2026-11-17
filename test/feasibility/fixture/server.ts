import { appendFile } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"

const threshold = 1
const budgetMessage = (reportedTokens: number) =>
  `Test token budget reached: reported usage ${reportedTokens} tokens meets the ${threshold}-token fixture ceiling.`

let armedSessionID: string | undefined

export default Plugin.define({
  id: "token-budget-feasibility-fixture",
  async setup(ctx) {
    await record({ event: "setup", pluginID: "token-budget-feasibility-fixture" })

    await ctx.command.transform((editor) =>
      editor.add({
        name: "arm-low-limit",
        description: "Enable the tiny token-budget feasibility threshold for this Session.",
        execute: async (input) => {
          armedSessionID = input.sessionID
          await record({ event: "command-armed", sessionID: input.sessionID, threshold })
        },
      }),
    )

    await ctx.tool.transform((editor) =>
      editor.add({
        name: "feasibility_noop",
        description: "A harmless fixture tool used to test preservation of completed work.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input, context) => {
          await record({ event: "noop-completed", sessionID: context.sessionID })
          return { content: "fixture noop completed" }
        },
      }),
    )

    await ctx.session.hook("model.request", async (event) => {
      await record({ event: "model-request-observed", sessionID: event.sessionID, kind: event.kind })
      if (event.kind !== "primary") return
      if (event.sessionID !== armedSessionID) {
        await record({ event: "model-request-pass", sessionID: event.sessionID, kind: event.kind })
        return
      }

      const messages = await ctx.session.context({ sessionID: event.sessionID })
      const reportedTokens = messages.reduce((total, message) => {
        if (message.type !== "assistant" || message.tokens === undefined) return total
        const tokens = message.tokens
        return total + tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
      }, 0)
      const reject = reportedTokens >= threshold
      await record({
        event: "model-request",
        sessionID: event.sessionID,
        kind: event.kind,
        reportedTokens,
        threshold,
        decision: reject ? "reject" : "allow",
      })

      if (reject) {
        const message = budgetMessage(reportedTokens)
        await record({ event: "budget-rejected", sessionID: event.sessionID, message })
        throw new Error(message)
      }
    })
  },
})

async function record(value: Record<string, unknown>) {
  const file = process.env.OPENCODE_TEST_EVIDENCE_FILE
  if (!file) throw new Error("OPENCODE_TEST_EVIDENCE_FILE is required by the feasibility fixture")
  await appendFile(file, `${JSON.stringify(value)}\n`)
}
