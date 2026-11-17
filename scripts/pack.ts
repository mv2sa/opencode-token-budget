import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

export function privateEnvironment(root: string) {
  const home = join(root, ".cache", "dev-env", "corrections-package-home")
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(root, ".cache", "dev-env", "corrections-package-xdg-config"),
    XDG_CACHE_HOME: join(root, ".cache", "dev-env", "corrections-package-xdg-cache"),
    XDG_DATA_HOME: join(root, ".cache", "dev-env", "corrections-package-xdg-data"),
    XDG_STATE_HOME: join(root, ".cache", "dev-env", "corrections-package-xdg-state"),
    TMPDIR: join(root, ".cache", "dev-env", "corrections-package-tmp"),
    BUN_AUTO_INSTALL: "0",
    BUN_INSTALL_CACHE_DIR: join(root, ".cache", "dev-env", "bun-cache"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  }
}

export async function pack() {
  const root = resolve(import.meta.dir, "..")
  const stage = join(root, ".cache", "dev-env", "corrections-package-stage")
  const output = join(root, "artifacts", "corrections")
  const dist = join(root, "dist")
  const sourceManifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  if (!isRecord(sourceManifest) || typeof sourceManifest.name !== "string" || typeof sourceManifest.version !== "string")
    throw new Error("Invalid project package manifest")
  if (!(await Bun.file(join(dist, "index.js")).exists())) throw new Error("Build dist/index.js before packaging")

  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true, mode: 0o700 })
  await mkdir(output, { recursive: true })
  await cp(dist, join(stage, "dist"), { recursive: true })
  await cp(join(root, "README.md"), join(stage, "README.md"))
  await cp(join(root, "LICENSE"), join(stage, "LICENSE"))
  const manifest = {
    name: sourceManifest.name,
    version: sourceManifest.version,
    type: "module",
    license: "MIT",
    files: ["dist", "README.md", "LICENSE"],
    exports: { "./server": { import: "./dist/index.js" } },
    peerDependencies: { "@opencode/plugin": "2.2.5", "@opencode/schema": "2.2.5", effect: "4.0.6" },
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  const tarball = join(output, `${sourceManifest.name}-${sourceManifest.version}.tgz`)
  await rm(tarball, { force: true })
  const process = Bun.spawn([processExecPath(), "pm", "pack", "--destination", output], {
    cwd: stage,
    env: privateEnvironment(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(process.stdout).text()
  const stderr = new Response(process.stderr).text()
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(`bun pm pack failed: ${(await stderr).trim()} ${(await stdout).trim()}`)
  if (!(await Bun.file(tarball).exists())) throw new Error(`Package tarball was not created: ${tarball}`)
  return tarball
}

function processExecPath() {
  return process.execPath
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (import.meta.main) await pack()
