import { OpenCode } from "@opencode/client/promise"
import type { OpenCodeEvent } from "@opencode/client"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { createEventTracker } from "./terminal-events"

export interface ProviderCall {
  readonly path: string
  readonly sessionID: string | null
  readonly model?: string
  readonly toolNames: ReadonlyArray<string>
}

export interface LocalProvider {
  readonly origin: string
  readonly calls: ProviderCall[]
  readonly stop: () => void
}

export interface HostReport {
  readonly exitCode: number
  readonly closed: boolean
  readonly stdout: string
  readonly stderr: string
  readonly applicationLog: string
}

export interface RunningHost {
  readonly client: ReturnType<typeof OpenCode.make>
  readonly origin: string
  readonly project: string
  readonly secondProject: string
  readonly version: string
  readonly binarySha256: string
  readonly nodeVersion: string
  readonly waitForStepEnded: (sessionID: string) => Promise<Extract<OpenCodeEvent, { type: "session.step.ended" }>>
  readonly waitForFailure: (sessionID: string, afterSequence?: number) => Promise<Extract<OpenCodeEvent, { type: "session.execution.failed" }>>
  readonly waitForSuccess: (sessionID: string, afterSequence?: number) => Promise<Extract<OpenCodeEvent, { type: "session.execution.succeeded" }>>
  readonly waitForTerminal: (sessionID: string, afterSequence?: number) => Promise<Extract<OpenCodeEvent, { type: "session.execution.failed" | "session.execution.succeeded" }>>
  readonly close: () => Promise<HostReport>
}

const serverPassword = "private-integration-password-only"

export async function startProvider(respond: (call: ProviderCall) => Response | Promise<Response>): Promise<LocalProvider> {
  const calls: ProviderCall[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      let raw: unknown
      if (request.method === "POST") {
        try {
          raw = await request.json()
        } catch {
          return new Response("Invalid JSON", { status: 400 })
        }
      }
      const body = isRecord(raw) ? raw : undefined
      const toolNames = Array.isArray(body?.tools)
        ? body.tools.flatMap((tool) =>
            isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string"
              ? [tool.function.name]
              : [],
          )
        : []
      const call: ProviderCall = {
        path: url.pathname,
        sessionID: request.headers.get("x-opencode-session-id"),
        ...(typeof body?.model === "string" ? { model: body.model } : {}),
        toolNames,
      }
      calls.push(call)
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
        return Response.json({ error: "Unexpected loopback provider endpoint" }, { status: 404 })
      return respond(call)
    },
  })
  return {
    origin: server.url.origin,
    calls,
    stop: () => server.stop(true),
  }
}

export async function startHost(input: {
  readonly workspaceRoot: string
  readonly runDir: string
  readonly config: unknown
}): Promise<RunningHost> {
  const hostRoot = join(input.runDir, "host")
  const home = join(hostRoot, "home")
  const configDir = join(hostRoot, "xdg-config", "opencode")
  const data = join(hostRoot, "xdg-data")
  const cache = join(hostRoot, "xdg-cache")
  const state = join(hostRoot, "xdg-state")
  const tmp = join(hostRoot, "tmp")
  const project = join(hostRoot, "project-root")
  const secondProject = join(hostRoot, "project-child-location")
  await Promise.all([home, configDir, data, cache, state, tmp, project, secondProject].map((path) => mkdir(path, { recursive: true, mode: 0o700 })))
  await writeFile(join(home, ".gitconfig"), "", { mode: 0o600 })
  const nodeBinary = Bun.which("node")
  if (!nodeBinary) throw new Error("Node 24.18.0 must be available from the qualified validation PATH")
  const nodeVersionResult = Bun.spawnSync([nodeBinary, "--version"], { cwd: project, stdout: "pipe", stderr: "pipe" })
  const nodeVersion = new TextDecoder().decode(nodeVersionResult.stdout).trim()
  if (nodeVersionResult.exitCode !== 0 || nodeVersion !== "v24.18.0")
    throw new Error(`Unexpected qualified Node version: ${nodeVersion}`)

  const env = {
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(hostRoot, "xdg-config"),
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    TMPDIR: tmp,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    OPENCODE_PASSWORD: serverPassword,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    PATH: `${dirname(nodeBinary)}:/usr/bin:/bin`,
  }
  await writeFile(join(configDir, "opencode.json"), JSON.stringify(input.config), { mode: 0o600 })
  for (const directory of [project, secondProject]) await initializeProject(directory, env)

  const cliManifestPath = join(input.workspaceRoot, ".cache", "host", "cli", "node_modules", "@opencode", "cli", "package.json")
  const cliManifest = await readJson(cliManifestPath)
  if (!isRecord(cliManifest) || !isRecord(cliManifest.bin) || typeof cliManifest.version !== "string")
    throw new Error("The staged public CLI package manifest is invalid")
  if (typeof cliManifest.bin.opencode !== "string") throw new Error("The public CLI package has no opencode binary")
  const binary = resolve(dirname(cliManifestPath), cliManifest.bin.opencode)
  const binarySha256 = createHash("sha256").update(await readFile(binary)).digest("hex")
  const versionProcess = Bun.spawn([binary, "--version"], { cwd: project, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const versionStdout = new Response(versionProcess.stdout).text()
  const versionStderr = new Response(versionProcess.stderr).text()
  const versionExit = await versionProcess.exited
  const version = (await versionStdout).trim()
  if (versionExit !== 0 || !version.includes("v2.2.5")) throw new Error(`Unexpected public host version: ${version} ${(await versionStderr).trim()}`)

  const ready = deferred<string>()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const process = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutPump = capture(process.stdout, stdoutChunks, (line) => {
    const match = /server listening on (http:\/\/[^\s]+)/iu.exec(line)
    if (match?.[1]) ready.resolve(match[1])
  })
  const stderrPump = capture(process.stderr, stderrChunks)
  void process.exited.then((code) => ready.reject(new Error(`Public host exited before readiness (${code})`)))

  let origin: string
  try {
    origin = new URL(await ready.promise).origin
  } catch (error) {
    process.kill("SIGTERM")
    await process.exited
    await Promise.all([stdoutPump, stderrPump])
    throw error
  }
  const client = OpenCode.make({
    baseUrl: origin,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` },
  })
  const controller = new AbortController()
  const events = client.event
    .subscribe({
      signal: controller.signal,
      types: ["session.execution.failed", "session.execution.succeeded", "session.step.ended"],
    })
    [Symbol.asyncIterator]()
  const connected = await events.next()
  if (connected.done || connected.value.type !== "server.connected") {
    controller.abort()
    process.kill("SIGTERM")
    await process.exited
    await Promise.all([stdoutPump, stderrPump])
    throw new Error("Public host event stream did not publish server.connected")
  }

  const tracker = createEventTracker()
  const eventPump = (async () => {
    try {
      while (true) {
        const next = await events.next()
        if (next.done) break
        tracker.observe(next.value)
      }
      tracker.fail(new Error("Lifecycle event stream ended"))
    } catch (error) {
      tracker.fail(error)
    }
  })()
  const waitForTerminalEvent = <Event extends Extract<OpenCodeEvent, { type: "session.execution.failed" | "session.execution.succeeded" }>>(
    sessionID: string,
    afterSequence: number | undefined,
    predicate: (event: OpenCodeEvent) => event is Event,
  ) => {
    return tracker.waitForTerminal(sessionID, afterSequence, predicate)
  }
  const waitForStepEnded = (sessionID: string) =>
    tracker.waitFor(
      (event): event is Extract<OpenCodeEvent, { type: "session.step.ended" }> =>
        event.type === "session.step.ended" && event.data.sessionID === sessionID,
    )
  const waitForFailure = (sessionID: string, afterSequence?: number) =>
    waitForTerminalEvent(
      sessionID,
      afterSequence,
      (event): event is Extract<OpenCodeEvent, { type: "session.execution.failed" }> =>
        event.type === "session.execution.failed" && event.data.sessionID === sessionID,
    )
  const waitForSuccess = (sessionID: string, afterSequence?: number) =>
    waitForTerminalEvent(
      sessionID,
      afterSequence,
      (event): event is Extract<OpenCodeEvent, { type: "session.execution.succeeded" }> =>
        event.type === "session.execution.succeeded" && event.data.sessionID === sessionID,
    )
  const waitForTerminal = (sessionID: string, afterSequence?: number) =>
    waitForTerminalEvent(
      sessionID,
      afterSequence,
      (event): event is Extract<OpenCodeEvent, { type: "session.execution.failed" | "session.execution.succeeded" }> =>
        (event.type === "session.execution.failed" || event.type === "session.execution.succeeded") &&
        event.data.sessionID === sessionID,
    )

  let closeResult: HostReport | undefined
  return {
    client,
    origin,
    project,
    secondProject,
    version,
    binarySha256,
    nodeVersion,
    waitForStepEnded,
    waitForFailure,
    waitForSuccess,
    waitForTerminal,
    async close() {
      if (closeResult) return closeResult
      controller.abort()
      try {
        await events.return?.()
      } catch {
        // The abort settles the owned event stream during shutdown.
      }
      await eventPump
      process.kill("SIGTERM")
      const exitCode = await process.exited
      let closed = false
      try {
        const response = await fetch(`${origin}/api/info`)
        await response.body?.cancel()
      } catch {
        closed = true
      }
      await Promise.all([stdoutPump, stderrPump])
      const applicationLogPath = join(data, "opencode", "log", "opencode.log")
      const applicationLog = (await Bun.file(applicationLogPath).exists()) ? await readFile(applicationLogPath, "utf8") : ""
      closeResult = {
        exitCode,
        closed,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        applicationLog: sanitize(applicationLog, input.workspaceRoot, input.runDir),
      }
      return closeResult
    },
  }
}

async function initializeProject(path: string, env: Record<string, string>) {
  const git = Bun.which("git")
  if (!git) throw new Error("git is required to isolate project instruction discovery")
  const result = Bun.spawnSync([git, "-c", "init.defaultBranch=main", "init", "--quiet"], {
    cwd: path,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`Could not create private project root: ${new TextDecoder().decode(result.stderr)}`)
}

async function capture(stream: ReadableStream<Uint8Array>, chunks: string[], onLine?: (line: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  while (true) {
    const item = await reader.read()
    if (item.done) break
    const text = decoder.decode(item.value, { stream: true })
    chunks.push(text)
    pending += text
    const lines = pending.split(/\r?\n/u)
    pending = lines.pop() ?? ""
    for (const line of lines) onLine?.(line)
  }
  pending += decoder.decode()
  if (pending) {
    chunks.push(pending)
    onLine?.(pending)
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function readJson(path: string): Promise<unknown> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitize(value: string, root: string, runDir: string) {
  return value.replaceAll(runDir, "<run>").replaceAll(root, "<workspace>").replaceAll(serverPassword, "[redacted]")
}
