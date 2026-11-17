import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { pack, privateEnvironment } from "./pack"

const root = resolve(import.meta.dir, "..")
const output = join(root, "artifacts", "corrections")
const consumerRoot = join(root, ".cache", "dev-env", "corrections-package-consumers")
await mkdir(consumerRoot, { recursive: true, mode: 0o700 })
const consumer = await mkdtemp(join(consumerRoot, "consumer-"))
const tarball = await pack()
const manifestPath = join(root, "package.json")
const sourceManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
if (!isRecord(sourceManifest) || typeof sourceManifest.name !== "string" || typeof sourceManifest.version !== "string")
  throw new Error("Invalid source package manifest")

let failure: unknown
try {
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        name: "token-budget-package-consumer",
        private: true,
        type: "module",
        dependencies: {
          [sourceManifest.name]: `file:${tarball}`,
          "@opencode/plugin": "2.2.5",
          "@opencode/schema": "2.2.5",
          effect: "4.0.6",
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  const install = Bun.spawn([process.execPath, "install", "--no-progress"], {
    cwd: consumer,
    env: privateEnvironment(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const installStdout = new Response(install.stdout).text()
  const installStderr = new Response(install.stderr).text()
  const installExit = await install.exited
  if (installExit !== 0) throw new Error(`Private package consumer install failed: ${(await installStderr).trim()} ${(await installStdout).trim()}`)

  const installedManifestPath = join(consumer, "node_modules", sourceManifest.name, "package.json")
  const installedManifest: unknown = JSON.parse(await readFile(installedManifestPath, "utf8"))
  if (!isRecord(installedManifest) || !isRecord(installedManifest.exports) || !isRecord(installedManifest.exports["./server"]))
    throw new Error("Installed tarball has no ./server export")
  const exportPath = installedManifest.exports["./server"].import
  if (exportPath !== "./dist/index.js") throw new Error(`Unexpected package server export: ${String(exportPath)}`)
  const installedEntry = join(consumer, "node_modules", sourceManifest.name, "dist", "index.js")
  const builtSource = await readFile(installedEntry, "utf8")
  if (builtSource.includes("@opencode/core") || builtSource.includes("@opencode/server"))
    throw new Error("Built plugin imports a Core/Server internal module")

  const sourceLicense = await readFile(join(root, "LICENSE"))
  const packedLicense = await extractPackageFile(tarball, "package/LICENSE")
  if (!sourceLicense.equals(packedLicense)) throw new Error("Packed MIT license does not match the repository LICENSE file")
  const installedLicense = await readFile(join(consumer, "node_modules", sourceManifest.name, "LICENSE"))
  if (!sourceLicense.equals(installedLicense)) throw new Error("Installed MIT license does not match the repository LICENSE file")

  const smokePath = join(consumer, "consumer-smoke.ts")
  await writeFile(
    smokePath,
    `import plugin from ${JSON.stringify(`${sourceManifest.name}/server`)}\nif (plugin.id !== "opencode.token-budget" || typeof plugin.setup !== "function") throw new Error("invalid installed plugin export")\n`,
    { mode: 0o600 },
  )
  const smoke = Bun.spawn([process.execPath, "run", smokePath], {
    cwd: consumer,
    env: privateEnvironment(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const smokeStdout = new Response(smoke.stdout).text()
  const smokeStderr = new Response(smoke.stderr).text()
  const smokeExit = await smoke.exited
  if (smokeExit !== 0) throw new Error(`Installed export smoke test failed: ${(await smokeStderr).trim()} ${(await smokeStdout).trim()}`)

  const tarballSha256 = createHash("sha256").update(await readFile(tarball)).digest("hex")
  await mkdir(output, { recursive: true })
  await writeFile(
    join(output, `package-binding-${basename(consumer)}.json`),
    `${JSON.stringify(
      {
        outcome: "passed",
        package: sourceManifest.name,
        version: sourceManifest.version,
        tarball: "opencode-token-budget-0.1.0.tgz",
        tarballSha256,
        licenseSha256: createHash("sha256").update(sourceLicense).digest("hex"),
        licenseVerified: true,
        consumerExport: exportPath,
        coreServerRuntimeImports: false,
        consumerImport: "opencode-token-budget/server",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
} catch (error) {
  failure = error
  await mkdir(output, { recursive: true })
  await writeFile(
    join(output, `package-failure-${basename(consumer)}.json`),
    `${JSON.stringify({ error: errorMessage(error) }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

if (failure === undefined) {
  await rm(consumer, { recursive: true, force: true })
  process.stdout.write("Package tarball and installed ./server export verified.\n")
} else {
  throw failure
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function extractPackageFile(tarball: string, entry: string) {
  const extract = Bun.spawn(["tar", "-xOf", tarball, entry], {
    cwd: root,
    env: privateEnvironment(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(extract.stdout).arrayBuffer()
  const stderr = new Response(extract.stderr).text()
  const exitCode = await extract.exited
  if (exitCode !== 0) throw new Error(`Could not extract ${entry} from the package tarball: ${(await stderr).trim()}`)
  return Buffer.from(await stdout)
}
