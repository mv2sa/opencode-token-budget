import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const sourceRevision = "4ce137b39ef74318f3625fd7553a9eaccfd6f682"
const sourceVersion = "2.2.5"
const cliVersion = "2.2.5"
const repository = "anomalyco/opencode"
const candidateOnlyPaths = [
  "packages/core/src/session/allowance.ts",
  "packages/core/src/session/inference.ts",
  "**/*20261107210312*",
]
const root = await realpath(resolve(import.meta.dir, ".."))
const hostRoot = join(root, ".cache", "host")
const sourceRoot = join(hostRoot, "source")
const cliRoot = join(hostRoot, "cli")
const downloadsRoot = join(hostRoot, "source-archives")
const privateRoot = join(root, ".cache", "readiness-fresh", "host-prepare")
const outputRoot = join(root, "artifacts", "repository-readiness")

interface SourceBinding {
  readonly upstreamRepository: string
  readonly sourceRevision: string
  readonly sourceArchiveSha256: string
  readonly sourcePackageVersion: string
  readonly extractedSnapshot: string
  readonly runtimeHost: string
  readonly runtimeHostSourceImport: false
  readonly candidateOnlySourcePathsAbsent: ReadonlyArray<string>
  readonly publicPackageVersions: Readonly<Record<string, string>>
  readonly hostBinary: {
    readonly package: string
    readonly version: string
    readonly binary: string
    readonly binarySha256: string
    readonly reportedVersion: string
  }
  readonly toolchain: { readonly bun: string; readonly node: string }
  readonly sourceArchiveProvenance: string
  readonly sourceArchiveBytesVerifiedThisRun: boolean
}

async function main() {
  if (process.platform !== "linux") throw new Error("Repository host preparation currently supports Linux only")
  if (Bun.version !== "1.4.4") throw new Error(`Expected Bun 1.4.4, received ${Bun.version}`)

  const node = Bun.which("node")
  if (!node) throw new Error("Node 24.18.0 is required on PATH")
  const nodeVersionResult = Bun.spawnSync([node, "--version"], { stdout: "pipe", stderr: "pipe" })
  const nodeVersion = new TextDecoder().decode(nodeVersionResult.stdout).trim()
  if (nodeVersionResult.exitCode !== 0 || nodeVersion !== "v24.18.0")
    throw new Error(`Expected Node 24.18.0, received ${nodeVersion}`)

  await Promise.all([ensureOwnedDirectory(hostRoot), ensureOwnedDirectory(privateRoot), ensureOwnedDirectory(outputRoot)])
  const hostEnv = await privateEnvironment()
  const source = await prepareSource()
  const cli = await prepareCli(hostEnv)
  const publicPackageVersions = await packageVersions()
  const binding: SourceBinding = {
    upstreamRepository: repository,
    sourceRevision,
    sourceArchiveSha256: source.archiveSha256,
    sourcePackageVersion: source.packageVersion,
    extractedSnapshot: relative(root, sourceRoot),
    runtimeHost: `@opencode/cli@${cli.packageVersion} public Linux binary`,
    runtimeHostSourceImport: false,
    candidateOnlySourcePathsAbsent: candidateOnlyPaths,
    publicPackageVersions,
    hostBinary: {
      package: "@opencode/cli",
      version: cli.packageVersion,
      binary: relative(root, cli.binary),
      binarySha256: cli.binarySha256,
      reportedVersion: cli.reportedVersion,
    },
    toolchain: { bun: Bun.version, node: nodeVersion },
    sourceArchiveProvenance: source.provenance,
    sourceArchiveBytesVerifiedThisRun: source.bytesVerifiedThisRun,
  }
  const prepared = {
    outcome: "prepared",
    reused: {
      sourceSnapshot: source.reused,
      cliBinary: cli.reused,
    },
    sourceArchiveProvenance: source.provenance,
    sourceArchiveSha256: source.archiveSha256,
    sourceArchiveBytesVerifiedThisRun: source.bytesVerifiedThisRun,
    sourceRevision,
    sourcePackageVersion: source.packageVersion,
    cliPackageVersion: cli.packageVersion,
    cliBinarySha256: cli.binarySha256,
    cliReportedVersion: cli.reportedVersion,
    publicPackageVersions,
    toolchain: binding.toolchain,
    receipt: "artifacts/repository-readiness/source-binding.json",
  }

  await writeFile(join(outputRoot, "source-binding.json"), `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(outputRoot, "host-preparation.json"), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(
    `Prepared OpenCode source ${sourceRevision} and public CLI ${cli.packageVersion}; ` +
      `source=${source.reused ? "reused from verified receipt" : "downloaded and hashed"}, ` +
      `cli=${cli.reused ? "reused" : "installed"}.\n`,
  )
}

async function prepareSource() {
  const existing = await pathStat(sourceRoot)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error(`Refusing to replace non-directory or linked source snapshot: ${relative(root, sourceRoot)}`)
    await assertWithinRoot(sourceRoot, hostRoot)
    const binding = await existingSourceBinding()
    await verifySymlinks(sourceRoot)
    const packageVersion = await verifySourceTree(sourceRoot)
    let bytesVerifiedThisRun = false
    const archivePath = join(downloadsRoot, `opencode-${sourceRevision}.tar.gz`)
    const archiveStat = await pathStat(archivePath)
    if (archiveStat) {
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink())
        throw new Error(`Refusing to use a non-regular source archive cache entry: ${relative(root, archivePath)}`)
      const archiveSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex")
      if (archiveSha256 !== binding.sourceArchiveSha256)
        throw new Error("Cached source archive hash does not match the existing source binding receipt")
      if (validateArchiveEntries(archivePath) !== `opencode-${sourceRevision}`)
        throw new Error("Cached source archive has an unexpected root directory")
      bytesVerifiedThisRun = true
    }
    return {
      archiveSha256: binding.sourceArchiveSha256,
      packageVersion,
      reused: true,
      provenance: binding.sourceArchiveProvenance ?? "reused-from-existing-source-binding-receipt",
      bytesVerifiedThisRun,
    }
  }

  await ensureOwnedDirectory(downloadsRoot)
  const archivePath = join(downloadsRoot, `opencode-${sourceRevision}.tar.gz`)
  const archiveStat = await pathStat(archivePath)
  if (archiveStat && (!archiveStat.isFile() || archiveStat.isSymbolicLink()))
    throw new Error(`Refusing to use a non-regular source archive cache entry: ${relative(root, archivePath)}`)
  const archiveDownloaded = archiveStat === undefined
  if (archiveDownloaded) await downloadSourceArchive(archivePath)
  const archiveBytes = await readFile(archivePath)
  if (archiveBytes.byteLength === 0) throw new Error("Downloaded source archive is empty")
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex")
  const archiveRoot = validateArchiveEntries(archivePath)
  const stage = await mkdtemp(join(hostRoot, ".source-stage-"))
  await assertWithinRoot(stage, hostRoot)
  try {
    await run("tar", [
      "-xzf",
      archivePath,
      "-C",
      stage,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
    ], { cwd: root, env: await privateEnvironment() })
    const stagedRoot = await realpath(stage)
    if (stagedRoot !== stage) throw new Error("Source extraction staging directory changed unexpectedly")
    await verifySymlinks(stage)
    const packageVersion = await verifySourceTree(stage)
    if (archiveRoot !== `opencode-${sourceRevision}`)
      throw new Error(`Unexpected source archive root directory: ${archiveRoot}`)
    if (await pathStat(sourceRoot)) throw new Error("Source snapshot appeared during preparation; refusing to replace it")
    await rename(stage, sourceRoot)
    await assertWithinRoot(sourceRoot, hostRoot)
    return {
      archiveSha256,
      packageVersion,
      reused: false,
      provenance: archiveDownloaded ? `downloaded:${sourceArchiveUrl()}` : `reused-cached-archive:${relative(root, archivePath)}`,
      bytesVerifiedThisRun: true,
    }
  } catch (error) {
    throw new Error(`Source snapshot preparation failed in ${relative(root, stage)}: ${errorText(error)}`)
  }
}

async function existingSourceBinding() {
  for (const path of [
    join(outputRoot, "source-binding.json"),
    join(root, "artifacts", "feasibility", "source-binding.json"),
  ]) {
    if (!(await pathStat(path))) continue
    const value = await readJson(path)
    if (!isRecord(value)) throw new Error(`Invalid source binding receipt: ${relative(root, path)}`)
    if (value.sourceRevision !== sourceRevision || value.sourcePackageVersion !== sourceVersion)
      throw new Error(`Existing source receipt does not bind ${sourceRevision}: ${relative(root, path)}`)
    if (typeof value.sourceArchiveSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceArchiveSha256))
      throw new Error(`Existing source receipt has no valid archive hash: ${relative(root, path)}`)
    return {
      sourceArchiveSha256: value.sourceArchiveSha256,
      sourceArchiveProvenance:
        typeof value.sourceArchiveProvenance === "string"
          ? value.sourceArchiveProvenance
          : `reused-existing-receipt:${relative(root, path)}`,
    }
  }
  throw new Error("A source snapshot already exists but no trusted revision receipt is available; refusing to overwrite or claim it")
}

async function downloadSourceArchive(path: string) {
  const staging = join(dirname(path), `.download-${sourceRevision}-${randomUUID()}.tmp`)
  const response = await fetch(sourceArchiveUrl(), {
    headers: { "user-agent": "opencode-token-budget-host-preparation" },
    redirect: "error",
  })
  if (!response.ok) throw new Error(`Source archive download failed with HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error("Source archive download returned an empty body")
  await writeFile(staging, bytes, { mode: 0o600, flag: "wx" })
  await rename(staging, path)
}

function sourceArchiveUrl() {
  return `https://codeload.github.com/${repository}/tar.gz/${sourceRevision}`
}

function validateArchiveEntries(path: string) {
  const result = Bun.spawnSync(["tar", "-tzf", path], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0)
    throw new Error(`Could not list source archive safely: ${new TextDecoder().decode(result.stderr).trim()}`)
  const entries = new TextDecoder().decode(result.stdout).split(/\r?\n/u).filter(Boolean)
  if (entries.length === 0) throw new Error("Source archive contains no entries")
  let archiveRoot: string | undefined
  for (const entry of entries) {
    if (isAbsolute(entry) || entry.includes("\\")) throw new Error(`Unsafe source archive path: ${entry}`)
    const components = entry.split("/").filter((part) => part.length > 0)
    if (components.some((part) => part === "." || part === "..")) throw new Error(`Unsafe source archive path: ${entry}`)
    const top = components[0]
    if (!top) throw new Error(`Unsafe source archive path: ${entry}`)
    if (archiveRoot !== undefined && archiveRoot !== top)
      throw new Error(`Source archive has multiple root directories: ${archiveRoot}, ${top}`)
    archiveRoot = top
  }
  if (!archiveRoot) throw new Error("Source archive root directory is missing")
  return archiveRoot
}

async function verifySourceTree(source: string) {
  const packagePath = join(source, "package.json")
  const packageStat = await lstat(packagePath)
  if (!packageStat.isFile() || packageStat.isSymbolicLink()) throw new Error("Source root package.json is not a regular file")
  const manifest = await readJson(packagePath)
  if (!isRecord(manifest) || manifest.version !== sourceVersion)
    throw new Error(`Source snapshot package version must be ${sourceVersion}`)
  for (const path of candidateOnlyPaths.slice(0, 2)) {
    if (existsSync(join(source, path))) throw new Error(`Candidate-only source path unexpectedly exists: ${path}`)
  }
  if ([...new Bun.Glob("**/*20261107210312*").scanSync({ cwd: source })].length > 0)
    throw new Error("Candidate-only hardening source filenames were found in the public source snapshot")
  return manifest.version
}

async function verifySymlinks(directory: string, rootDirectory = directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      const target = await readlink(path)
      if (isAbsolute(target)) throw new Error(`Absolute symlink in source archive: ${relative(directory, path)}`)
      const resolved = resolve(dirname(path), target)
      const pathWithinRoot = relative(rootDirectory, resolved)
      if (pathWithinRoot === ".." || pathWithinRoot.startsWith(`..${sep}`) || isAbsolute(pathWithinRoot))
        throw new Error(`Symlink escapes source snapshot: ${relative(rootDirectory, path)} -> ${target}`)
      continue
    }
    if (info.isDirectory()) await verifySymlinks(path, rootDirectory)
    else if (!info.isFile()) throw new Error(`Unsupported file type in source archive: ${relative(directory, path)}`)
  }
}

async function prepareCli(env: Record<string, string>) {
  await ensureOwnedDirectory(cliRoot)
  const expected = {
    name: "opencode-token-budget-unmodified-host-stage",
    private: true,
    version: "0.0.0",
    type: "module",
    trustedDependencies: ["@opencode/cli"],
    dependencies: { "@opencode/cli": cliVersion },
  }
  const stageManifestPath = join(cliRoot, "package.json")
  if (existsSync(stageManifestPath)) {
    const value = await readJson(stageManifestPath)
    if (!isRecord(value) || value.name !== expected.name || value.version !== expected.version ||
      !isRecord(value.dependencies) || value.dependencies["@opencode/cli"] !== cliVersion ||
      !Array.isArray(value.trustedDependencies) || !value.trustedDependencies.includes("@opencode/cli"))
      throw new Error("Existing public CLI staging manifest is not the expected pinned package; refusing to modify it")
  } else {
    const entries = await readdir(cliRoot)
    if (entries.length > 0) throw new Error("Existing public CLI staging directory is unrecognized; refusing to modify it")
    await writeFile(stageManifestPath, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  }
  await assertInstallPathsOwned(cliRoot)

  const existing = await inspectCli()
  if (!existing) {
    const lockPath = join(cliRoot, "bun.lock")
    const installArgs = ["install", "--no-progress", ...(existsSync(lockPath) ? ["--frozen-lockfile"] : [])]
    await run(process.execPath, installArgs, { cwd: cliRoot, env })
  }

  const installed = await inspectCli()
  if (!installed) throw new Error("Pinned public CLI installation did not produce its declared binary")
  const reportedVersion = await cliVersionOutput(installed.binary, env)
  if (!reportedVersion.includes(`v${cliVersion}`))
    throw new Error(`Public CLI binary did not report v${cliVersion}: ${reportedVersion}`)
  return { ...installed, reportedVersion, reused: existing !== undefined }
}

async function inspectCli() {
  const manifestPath = join(cliRoot, "node_modules", "@opencode", "cli", "package.json")
  if (!(await pathStat(manifestPath))) return undefined
  const manifest = await readJson(manifestPath)
  if (!isRecord(manifest) || manifest.name !== "@opencode/cli" || manifest.version !== cliVersion || !isRecord(manifest.bin))
    throw new Error(`Installed public CLI package must be @opencode/cli@${cliVersion}`)
  if (typeof manifest.bin.opencode !== "string" || isAbsolute(manifest.bin.opencode))
    throw new Error("Public CLI package has an invalid opencode binary path")
  const packageRoot = dirname(manifestPath)
  const binary = resolve(packageRoot, manifest.bin.opencode)
  const binaryRelative = relative(packageRoot, binary)
  if (binaryRelative === ".." || binaryRelative.startsWith(`..${sep}`) || isAbsolute(binaryRelative))
    throw new Error("Public CLI binary path escapes its installed package")
  const packageReal = await realpath(packageRoot)
  if (!isWithin(packageReal, cliRoot)) throw new Error("Installed public CLI package resolves outside its owned staging path")
  const binaryReal = await realpath(binary)
  if (!isWithin(binaryReal, packageReal)) throw new Error("Public CLI binary resolves outside its installed package")
  const binaryStat = await lstat(binaryReal)
  if (!binaryStat.isFile() || binaryStat.size < 1_000_000 || (binaryStat.mode & 0o111) === 0)
    throw new Error("Public CLI binary is not a large executable regular file")
  return {
    binary: binaryReal,
    binarySha256: createHash("sha256").update(await readFile(binaryReal)).digest("hex"),
    packageVersion: manifest.version,
  }
}

async function cliVersionOutput(binary: string, env: Record<string, string>) {
  const result = await run(binary, ["--version"], { cwd: root, env })
  return result.stdout.trim()
}

async function packageVersions() {
  const output: Record<string, string> = {}
  for (const name of ["client", "plugin", "schema", "sdk"] as const) {
    const value = await readJson(join(root, "node_modules", "@opencode", name, "package.json"))
    if (!isRecord(value) || value.version !== sourceVersion)
      throw new Error(`Expected @opencode/${name}@${sourceVersion} in the locked workspace dependencies`)
    output[`@opencode/${name}`] = value.version
  }
  return output
}

async function privateEnvironment(): Promise<Record<string, string>> {
  const home = join(privateRoot, "home")
  const config = join(privateRoot, "xdg-config")
  const cache = join(privateRoot, "xdg-cache")
  const data = join(privateRoot, "xdg-data")
  const state = join(privateRoot, "xdg-state")
  const tmp = join(privateRoot, "tmp")
  const configDir = join(config, "opencode")
  await Promise.all([home, configDir, cache, data, state, tmp].map((path) => mkdir(path, { recursive: true, mode: 0o700 })))
  const gitConfig = join(home, ".gitconfig")
  if (!existsSync(gitConfig)) await writeFile(gitConfig, "", { mode: 0o600, flag: "wx" })
  return {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    TMPDIR: tmp,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    BUN_AUTO_INSTALL: "0",
    BUN_INSTALL_CACHE_DIR: join(privateRoot, "bun-cache"),
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  }
}

async function ensureOwnedDirectory(path: string) {
  const parent = resolve(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a real directory at ${relative(root, parent)}`)
  await assertWithinRoot(parent, root)
}

async function assertInstallPathsOwned(directory: string) {
  const nodeModules = join(directory, "node_modules")
  const info = await pathStat(nodeModules)
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Public CLI node_modules must be a real directory owned by its staging path")
  const actual = await realpath(nodeModules)
  if (!isWithin(actual, directory)) throw new Error("Public CLI node_modules resolves outside its owned staging path")
}

async function assertWithinRoot(path: string, parent: string) {
  const [actual, actualParent] = await Promise.all([realpath(path), realpath(parent)])
  if (!isWithin(actual, actualParent)) throw new Error(`Path escapes its owned staging root: ${relative(root, path)}`)
}

async function pathStat(path: string) {
  if (!existsSync(path)) return undefined
  return lstat(path)
}

function isWithin(path: string, parent: string) {
  const rel = relative(parent, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function run(command: string, args: string[], options: { cwd: string; env: Record<string, string> }) {
  const process = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(process.stdout).text()
  const stderr = new Response(process.stderr).text()
  const exitCode = await process.exited
  const result = { stdout: await stdout, stderr: await stderr, exitCode }
  if (exitCode !== 0)
    throw new Error(`${basename(command)} ${args.join(" ")} failed (${exitCode}): ${result.stderr.trim()} ${result.stdout.trim()}`)
  return result
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

try {
  await main()
} catch (error) {
  try {
    await ensureOwnedDirectory(outputRoot)
    const failurePath = join(outputRoot, `prepare-failure-${randomUUID()}.json`)
    await writeFile(failurePath, `${JSON.stringify({ outcome: "failed", error: errorText(error) }, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Keep the original preparation error if the owned receipt directory is unavailable.
  }
  throw error
}
