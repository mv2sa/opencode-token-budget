import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "token-budget-test-pre-send-reject-once",
  async setup(ctx) {
    let rejected = false
    await ctx.session.hook("model.request", async () => {
      if (rejected) return
      rejected = true
      throw new Error("fixture pre-send rejection")
    })
  },
})
