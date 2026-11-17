import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const output = resolve(root, "dist")

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: output,
  target: "bun",
  format: "esm",
  external: ["@opencode/plugin", "effect"],
})
if (!result.success) throw new AggregateError(result.logs.map((log) => new Error(log.message)), "Token-budget build failed")
if (!(await Bun.file(resolve(output, "index.js")).exists())) throw new Error("Build did not emit dist/index.js")
