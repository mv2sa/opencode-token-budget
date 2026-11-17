import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client/promise"
import type { OpenCodeEvent } from "@opencode/client"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const sourceRevision = "4ce137b39ef74318f3625fd7553a9eaccfd6f682"
const hostVersion = "2.2.5"
const pluginID = "token-budget-feasibility-fixture"
const providerID = "token-budget-feasibility-local"
const modelID = "feasibility-model"
const commandName = "arm-low-limit"
const toolName = "feasibility_noop"
const serverPassword = "local-feasibility-password-only"
const providerApiKey = "local-feasibility-api-key-only"

interface ProviderObservation {
  readonly path: string
  readonly sessionID: string | null
  readonly model?: string
  readonly toolNames: ReadonlyArray<string>
}

const workspaceRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const sourceRoot = join(workspaceRoot, ".cache", "host", "source")
const fixtureRoot = resolve(fileURLToPath(new URL("./fixture/", import.meta.url)))

test("configured Promise plugin gates the next model request before provider dispatch on an unmodified V2 host", async () => {
  const preparedSourceBinding = await readJson(join(workspaceRoot, "artifacts", "repository-readiness", "source-binding.json"))
  if (
    !isRecord(preparedSourceBinding) ||
    preparedSourceBinding.sourceRevision !== sourceRevision ||
    preparedSourceBinding.sourcePackageVersion !== hostVersion ||
    typeof preparedSourceBinding.sourceArchiveSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(preparedSourceBinding.sourceArchiveSha256) ||
    typeof preparedSourceBinding.sourceArchiveProvenance !== "string" ||
    typeof preparedSourceBinding.sourceArchiveBytesVerifiedThisRun !== "boolean"
  )
    throw new Error("Prepared public source binding does not match the pinned reference revision")
  const sourceArchiveSha256 = preparedSourceBinding.sourceArchiveSha256

  const canaryPath = join(workspaceRoot, ".cache", "dev-env", "survival-canary.txt")
  await mkdir(dirname(canaryPath), { recursive: true, mode: 0o700 })
  if (!(await Bun.file(canaryPath).exists()))
    await writeFile(canaryPath, "Preserve this canary; it is outside per-run scratch.\n", { mode: 0o600 })
  const canary = await readFile(canaryPath, "utf8")

  const runsRoot = join(workspaceRoot, ".cache", "dev-env", "runs")
  await mkdir(runsRoot, { recursive: true, mode: 0o700 })
  const runDir = await mkdtemp(join(runsRoot, "feasibility-"))
  const runID = basename(runDir)
  const hostRoot = join(runDir, "host")
  const hostHome = join(hostRoot, "home")
  const hostConfigDir = join(hostRoot, "xdg-config", "opencode")
  const hostDataDir = join(hostRoot, "xdg-data")
  const hostCacheDir = join(hostRoot, "xdg-cache")
  const hostStateDir = join(hostRoot, "xdg-state")
  const hostTmpDir = join(hostRoot, "tmp")
  const projectDir = join(hostRoot, "project")
  const pluginEvidencePath = join(runDir, "plugin-evidence.ndjson")
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const providerRequests: ProviderObservation[] = []
  const cleanupFailures: string[] = []
  const evidence: Record<string, unknown> = {
    runID,
    source: {
      revision: sourceRevision,
      archiveSha256: sourceArchiveSha256,
      packageVersion: hostVersion,
      snapshot: ".cache/host/source",
      runtimeUsesSnapshotSources: false,
      archiveProvenance: preparedSourceBinding.sourceArchiveProvenance,
      archiveBytesVerifiedThisRun: preparedSourceBinding.sourceArchiveBytesVerifiedThisRun,
    },
    publicPackages: {},
    providerRequests,
    privateRunDirectory: relative(workspaceRoot, runDir),
  }

  let hostProcess: ReturnType<typeof Bun.spawn> | undefined
  let providerServer: ReturnType<typeof Bun.serve> | undefined
  let eventController: AbortController | undefined
  let closeEvents: (() => Promise<void>) | undefined
  let serverOrigin: string | undefined
  let stdoutPump = Promise.resolve()
  let stderrPump = Promise.resolve()
  let failure: unknown

  try {
    await Promise.all(
      [hostHome, hostConfigDir, hostDataDir, hostCacheDir, hostStateDir, hostTmpDir, projectDir].map((directory) =>
        mkdir(directory, { recursive: true, mode: 0o700 }),
      ),
    )
    await writeFile(pluginEvidencePath, "", { mode: 0o600 })
    await writeFile(join(hostHome, ".gitconfig"), "", { mode: 0o600 })

    const publicPackageVersions: Record<string, string> = {}
    for (const packageName of ["client", "plugin", "schema", "sdk"] as const) {
      const manifestPath = join(workspaceRoot, "node_modules", "@opencode", packageName, "package.json")
      const manifest = await readJson(manifestPath)
      if (!isRecord(manifest) || typeof manifest.version !== "string")
        throw new Error(`Invalid installed @opencode/${packageName} manifest`)
      publicPackageVersions[`@opencode/${packageName}`] = manifest.version
      expect(manifest.version).toBe(hostVersion)
    }
    evidence.publicPackages = publicPackageVersions

    const sourceManifest = await readJson(join(sourceRoot, "package.json"))
    expect(isRecord(sourceManifest) ? sourceManifest.version : undefined).toBe(hostVersion)
    const candidateOnlyPaths = [
      "packages/core/src/session/allowance.ts",
      "packages/core/src/session/inference.ts",
    ]
    const candidateOnlyMatches = [...new Bun.Glob("**/*20261107210312*").scanSync({ cwd: sourceRoot })]
    for (const path of candidateOnlyPaths) expect(await Bun.file(join(sourceRoot, path)).exists()).toBe(false)
    expect(candidateOnlyMatches).toEqual([])
    evidence.candidateOnlySourcePathsAbsent = [...candidateOnlyPaths, "**/*20261107210312*"]

    const cliManifestPath = join(workspaceRoot, ".cache", "host", "cli", "node_modules", "@opencode", "cli", "package.json")
    const cliManifest = await readJson(cliManifestPath)
    if (!isRecord(cliManifest) || typeof cliManifest.version !== "string" || !isRecord(cliManifest.bin))
      throw new Error("Invalid installed @opencode/cli manifest")
    expect(cliManifest.version).toBe(hostVersion)
    if (typeof cliManifest.bin.opencode !== "string") throw new Error("The public CLI package has no opencode binary")
    const cliBinary = resolve(dirname(cliManifestPath), cliManifest.bin.opencode)
    const binaryDigest = createHash("sha256").update(await readFile(cliBinary)).digest("hex")
    const hostEnv = {
      HOME: hostHome,
      OPENCODE_TEST_HOME: hostHome,
      XDG_CONFIG_HOME: join(hostRoot, "xdg-config"),
      XDG_DATA_HOME: hostDataDir,
      XDG_CACHE_HOME: hostCacheDir,
      XDG_STATE_HOME: hostStateDir,
      TMPDIR: hostTmpDir,
      OPENCODE_CONFIG_DIR: hostConfigDir,
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FFF: "1",
      OPENCODE_FILEWATCHER_DISABLE: "1",
      OPENCODE_PASSWORD: serverPassword,
      OPENCODE_TEST_EVIDENCE_FILE: pluginEvidencePath,
      GIT_CONFIG_GLOBAL: join(hostHome, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
      PATH: "/usr/bin:/bin",
    }

    const git = Bun.which("git")
    if (!git) throw new Error("git is required to create the isolated test project root")
    const gitInit = Bun.spawnSync(
      [git, "-c", "init.defaultBranch=main", "init", "--quiet"],
      { cwd: projectDir, env: hostEnv, stdout: "pipe", stderr: "pipe" },
    )
    if (gitInit.exitCode !== 0)
      throw new Error(`Failed to initialize the private host project: ${new TextDecoder().decode(gitInit.stderr)}`)

    const versionProcess = Bun.spawn([cliBinary, "--version"], {
      cwd: projectDir,
      env: hostEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const versionStdout = new Response(versionProcess.stdout).text()
    const versionStderr = new Response(versionProcess.stderr).text()
    const versionExit = await versionProcess.exited
    const reportedVersion = (await versionStdout).trim()
    const versionError = (await versionStderr).trim()
    if (versionExit !== 0) throw new Error(`Public CLI --version failed: ${versionError}`)
    expect(reportedVersion).toContain(`v${hostVersion}`)
    evidence.host = {
      package: "@opencode/cli",
      version: cliManifest.version,
      binary: relative(workspaceRoot, cliBinary),
      binarySha256: binaryDigest,
      reportedVersion,
    }
    const nodeBinary = Bun.which("node")
    if (!nodeBinary) throw new Error("Node 24.18.0 must be available from the qualified validation PATH")
    const nodeVersionProcess = Bun.spawn([nodeBinary, "--version"], {
      cwd: projectDir,
      env: hostEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const nodeVersionStdout = new Response(nodeVersionProcess.stdout).text()
    const nodeVersionStderr = new Response(nodeVersionProcess.stderr).text()
    const nodeVersionExit = await nodeVersionProcess.exited
    const nodeVersion = (await nodeVersionStdout).trim()
    if (nodeVersionExit !== 0) throw new Error(`Qualified Node --version failed: ${(await nodeVersionStderr).trim()}`)
    expect(nodeVersion).toBe("v24.18.0")
    evidence.toolchain = { bun: Bun.version, node: nodeVersion }

    let armedProviderSessionID: string | undefined
    providerServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        let payload: unknown
        if (request.method === "POST") {
          try {
            payload = await request.json()
          } catch {
            return new Response("Invalid JSON", { status: 400 })
          }
        }
        const input = isRecord(payload) ? payload : undefined
        const toolNames = Array.isArray(input?.tools)
          ? input.tools.flatMap((tool) => {
              if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") return []
              return [tool.function.name]
            })
          : []
        const sessionID = request.headers.get("x-opencode-session-id")
        providerRequests.push({
          path: url.pathname,
          sessionID,
          ...(typeof input?.model === "string" ? { model: input.model } : {}),
          toolNames,
        })
        if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
          return Response.json({ error: "Unexpected local provider endpoint" }, { status: 404 })
        if (!input) return Response.json({ error: "Expected a JSON model request" }, { status: 400 })
        return openAIStream(sessionID !== null && sessionID === armedProviderSessionID)
      },
    })

    const config = {
      plugins: [fixtureRoot],
      instructions: [],
      providers: {
        [providerID]: {
          name: "Token-budget loopback fixture",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: `${providerServer.url.origin}/v1`,
            apiKey: providerApiKey,
            provider: "token-budget-feasibility",
          },
          models: {
            [modelID]: {
              name: "Feasibility fixture model",
              modelID,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 32_000, output: 1_024 },
            },
          },
        },
      },
    }
    await writeFile(join(hostConfigDir, "opencode.json"), JSON.stringify(config, null, 2), { mode: 0o600 })

    const ready = deferred<string>()
    const serverProcess = Bun.spawn([cliBinary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: projectDir,
      env: hostEnv,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    hostProcess = serverProcess
    stdoutPump = captureStream(serverProcess.stdout, stdoutChunks, (line) => {
      const match = /server listening on (http:\/\/[^\s]+)/i.exec(line)
      if (match?.[1]) ready.resolve(match[1])
    })
    stderrPump = captureStream(serverProcess.stderr, stderrChunks)
    void serverProcess.exited.then((code) => ready.reject(new Error(`Unmodified host exited before readiness (${code})`)))
    const serverURL = await ready.promise
    serverOrigin = new URL(serverURL).origin
    expect(new URL(serverURL).hostname).toBe("127.0.0.1")
    evidence.serverOrigin = serverOrigin

    const client = OpenCode.make({
      baseUrl: serverOrigin,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` },
    })
    eventController = new AbortController()
    const eventIterator = client.event
      .subscribe({
        signal: eventController.signal,
        types: ["session.execution.failed", "session.execution.succeeded"],
      })
      [Symbol.asyncIterator]()
    closeEvents = async () => {
      await eventIterator.return?.()
    }
    const connected = await eventIterator.next()
    if (connected.done || connected.value.type !== "server.connected")
      throw new Error("The authenticated lifecycle event stream did not publish server.connected")

    const waitForFailure = async (sessionID: string, afterSequence: number) => {
      while (true) {
        const next = await eventIterator.next()
        if (next.done) throw new Error("The lifecycle event stream ended before Session failure")
        if (next.value.type !== "session.execution.failed") continue
        if (next.value.data.sessionID !== sessionID || next.value.durable.seq <= afterSequence) continue
        return next.value
      }
    }
    const waitForSuccess = async (sessionID: string) => {
      while (true) {
        const next = await eventIterator.next()
        if (next.done) throw new Error("The lifecycle event stream ended before Session success")
        if (next.value.type !== "session.execution.succeeded" || next.value.data.sessionID !== sessionID) continue
        return next.value
      }
    }

    const location = { directory: projectDir }
    const session = await client.session.create({
      location,
      title: "Token-budget feasibility fixture",
      agent: "build",
      model: { id: modelID, providerID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    armedProviderSessionID = session.id
    await client.session.command({ sessionID: session.id, name: commandName, text: "" })
    expect(providerRequests).toEqual([])
    const pluginInventory = await client.plugin.list({ location })
    const loadedPlugin = pluginInventory.data.find((item) => item.id === pluginID)
    evidence.fixturePlugin = loadedPlugin
    expect(loadedPlugin?.features.server).toBe(true)
    const commands = await client.command.list({ location })
    expect(commands.data.some((item) => item.name === commandName)).toBe(true)
    const providers = await client.provider.list({ location })
    expect(providers.data.some((item) => item.id === providerID)).toBe(true)
    const models = await client.model.list({ location })
    expect(models.data.some((item) => item.id === modelID && item.providerID === providerID)).toBe(true)
    const afterCommand = await readFile(pluginEvidencePath, "utf8")
    expect(parseJsonLines(afterCommand).some((item) => isRecord(item) && item.event === "command-armed" && item.sessionID === session.id)).toBe(true)

    await client.session.prompt({ sessionID: session.id, text: "Call the harmless feasibility no-op once." })
    const firstFailure = await waitForFailure(session.id, 0)
    expect(firstFailure.data.error.message).toContain("Test token budget reached")
    expect(providerRequests.filter((item) => item.sessionID === session.id)).toHaveLength(1)
    const firstProviderRequest = providerRequests.find((item) => item.sessionID === session.id)
    expect(firstProviderRequest?.path).toBe("/v1/chat/completions")
    expect(firstProviderRequest?.model).toBe(modelID)
    expect(firstProviderRequest?.toolNames).toContain(toolName)
    expect(firstProviderRequest?.toolNames).not.toContain(commandName)

    const failedSession = await client.session.get({ sessionID: session.id })
    expect(failedSession.outcome).toBe("failed")
    const transcript = await client.session.context({ sessionID: session.id })
    const toolMessage = transcript.find(
      (message) =>
        message.type === "assistant" &&
        message.content.some((part) => part.type === "tool" && part.name === toolName),
    )
    if (!toolMessage || toolMessage.type !== "assistant") throw new Error("The completed fixture tool call was not preserved")
    expect(toolMessage.tokens).toEqual({
      input: 3,
      output: 2,
      reasoning: 1,
      cache: { read: 1, write: 1 },
    })
    const toolResult = toolMessage.content.find((part) => part.type === "tool" && part.name === toolName)
    if (!toolResult || toolResult.type !== "tool") throw new Error("The completed fixture tool result is missing")
    expect(toolResult.state.status).toBe("completed")
    if (toolResult.state.status === "completed")
      expect(toolResult.state.content).toContainEqual({ type: "text", text: "fixture noop completed" })
    const terminalMessage = transcript.findLast((message) => message.type === "idle")
    expect(terminalMessage?.outcome).toBe("failed")
    expect(terminalMessage?.error?.message).toContain("Test token budget reached")

    const firstPluginEvents = parseJsonLines(await readFile(pluginEvidencePath, "utf8"))
    expect(
      firstPluginEvents.some(
        (item) =>
          isRecord(item) &&
          item.event === "model-request" &&
          item.sessionID === session.id &&
          item.reportedTokens === 0 &&
          item.decision === "allow",
      ),
    ).toBe(true)
    expect(
      firstPluginEvents.some(
        (item) =>
          isRecord(item) &&
          item.event === "model-request" &&
          item.sessionID === session.id &&
          item.reportedTokens === 8 &&
          item.decision === "reject",
      ),
    ).toBe(true)

    await client.session.prompt({ sessionID: session.id, text: "continue" })
    const continueFailure = await waitForFailure(session.id, firstFailure.durable.seq)
    expect(continueFailure.data.error.message).toContain("Test token budget reached")
    expect(providerRequests.filter((item) => item.sessionID === session.id)).toHaveLength(1)

    const unrelatedSession = await client.session.create({
      location,
      title: "Unrelated healthy fixture Session",
      agent: "build",
      model: { id: modelID, providerID },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    await client.session.prompt({ sessionID: unrelatedSession.id, text: "Respond normally." })
    const unrelatedSuccess = await waitForSuccess(unrelatedSession.id)
    expect(providerRequests.filter((item) => item.sessionID === unrelatedSession.id)).toHaveLength(1)
    expect(providerRequests.filter((item) => item.sessionID === session.id)).toHaveLength(1)
    const unrelatedTranscript = await client.session.context({ sessionID: unrelatedSession.id })
    expect(
      unrelatedTranscript.some(
        (message) => message.type === "assistant" && message.content.some((part) => part.type === "text" && part.text.includes("unrelated Session remains healthy")),
      ),
    ).toBe(true)
    expect(hostProcess.exitCode).toBeNull()
    evidence.sessions = {
      budgetSessionID: session.id,
      unrelatedSessionID: unrelatedSession.id,
      firstFailure: {
        type: firstFailure.type,
        sequence: firstFailure.durable.seq,
        error: firstFailure.data.error,
      },
      continueFailure: {
        type: continueFailure.type,
        sequence: continueFailure.durable.seq,
        error: continueFailure.data.error,
      },
      unrelatedSuccess: {
        type: unrelatedSuccess.type,
        sequence: unrelatedSuccess.durable.seq,
        sessionID: unrelatedSuccess.data.sessionID,
      },
      preservedToolResult: true,
      reportedTokenUsage: 8,
    }
    evidence.finalProviderRequestCounts = {
      budgetSession: providerRequests.filter((item) => item.sessionID === session.id).length,
      unrelatedSession: providerRequests.filter((item) => item.sessionID === unrelatedSession.id).length,
      total: providerRequests.length,
    }
  } catch (error) {
    failure = error
  } finally {
    eventController?.abort()
    if (closeEvents) {
      try {
        await closeEvents()
      } catch (error) {
        cleanupFailures.push(`event stream close: ${errorText(error)}`)
      }
    }
    if (hostProcess) {
      try {
        hostProcess.kill("SIGTERM")
        evidence.hostExitCode = await hostProcess.exited
        evidence.hostProcessExited = true
      } catch (error) {
        cleanupFailures.push(`host process settle: ${errorText(error)}`)
      }
    }
    if (serverOrigin) {
      try {
        const response = await fetch(`${serverOrigin}/api/info`)
        await response.body?.cancel()
        evidence.hostServerClosed = false
        cleanupFailures.push(`host HTTP listener remained available after process exit (${response.status})`)
      } catch {
        evidence.hostServerClosed = true
      }
    }
    if (providerServer) {
      try {
        await providerServer.stop(true)
      } catch (error) {
        cleanupFailures.push(`loopback provider stop: ${errorText(error)}`)
      }
    }
    try {
      await Promise.all([stdoutPump, stderrPump])
    } catch (error) {
      cleanupFailures.push(`host log collection: ${errorText(error)}`)
    }

    const artifactDir = join(workspaceRoot, "artifacts", "feasibility")
    await mkdir(artifactDir, { recursive: true })
    const stdoutText = sanitizeOutput(stdoutChunks.join(""), workspaceRoot, runDir)
    const stderrText = sanitizeOutput(stderrChunks.join(""), workspaceRoot, runDir)
    const applicationLogPath = join(hostDataDir, "opencode", "log", "opencode.log")
    const applicationLogText = (await Bun.file(applicationLogPath).exists())
      ? sanitizeOutput(await readFile(applicationLogPath, "utf8"), workspaceRoot, runDir)
      : ""
    const pluginEvidenceText = (await Bun.file(pluginEvidencePath).exists())
      ? sanitizeOutput(await readFile(pluginEvidencePath, "utf8"), workspaceRoot, runDir)
      : ""
    const hostStdoutPath = `host-${runID}.stdout.log`
    const hostStderrPath = `host-${runID}.stderr.log`
    const applicationLogName = `host-${runID}.application.log`
    const pluginEventsPath = `plugin-${runID}.ndjson`
    await writeFile(join(artifactDir, hostStdoutPath), stdoutText, { mode: 0o600 })
    await writeFile(join(artifactDir, hostStderrPath), stderrText, { mode: 0o600 })
    await writeFile(join(artifactDir, applicationLogName), applicationLogText, { mode: 0o600 })
    await writeFile(join(artifactDir, pluginEventsPath), pluginEvidenceText, { mode: 0o600 })

    const failureDescription = failure === undefined ? undefined : sanitizeOutput(errorText(failure), workspaceRoot, runDir)
    const outcome = failureDescription || cleanupFailures.length > 0 ? "failed" : "passed"
    const sourceBinding = {
      upstreamRepository: "anomalyco/opencode",
      sourceRevision,
      sourceArchiveSha256,
      sourcePackageVersion: hostVersion,
      sourceArchiveProvenance: preparedSourceBinding.sourceArchiveProvenance,
      sourceArchiveBytesVerifiedThisRun: preparedSourceBinding.sourceArchiveBytesVerifiedThisRun,
      extractedSnapshot: ".cache/host/source",
      runtimeHost: "@opencode/cli@2.2.5 public Linux binary",
      runtimeHostSourceImport: false,
      candidateOnlySourcePathsAbsent: evidence.candidateOnlySourcePathsAbsent ?? [],
      publicPackageVersions: evidence.publicPackages ?? {},
      hostBinary: evidence.host ?? null,
      toolchain: evidence.toolchain ?? null,
    }
    await writeFile(join(artifactDir, "source-binding.json"), `${JSON.stringify(sourceBinding, null, 2)}\n`, {
      mode: 0o600,
    })
    const runtimeEvidence = {
      ...evidence,
      outcome,
      failure: failureDescription,
      cleanupFailures,
      hostStdout: hostStdoutPath,
      hostStderr: hostStderrPath,
      applicationLog: applicationLogName,
      pluginEvents: pluginEventsPath,
      providerRequests,
      survivalCanary: relative(workspaceRoot, canaryPath),
      survivalCanaryPreserved: (await Bun.file(canaryPath).exists()) && (await readFile(canaryPath, "utf8")) === canary,
      binaryVersion: evidence.host && isRecord(evidence.host) ? evidence.host.reportedVersion : undefined,
    }
    await writeFile(join(artifactDir, `runtime-${runID}.json`), `${JSON.stringify(runtimeEvidence, null, 2)}\n`, {
      mode: 0o600,
    })
    if (outcome === "failed") {
      await writeFile(
        join(artifactDir, `failure-${runID}.json`),
        `${JSON.stringify(
          {
            runID,
            failure: failureDescription,
            cleanupFailures,
            hostStdout: hostStdoutPath,
            hostStderr: hostStderrPath,
            applicationLog: applicationLogName,
            pluginEvents: pluginEventsPath,
            scratch: relative(workspaceRoot, runDir),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
    } else {
      try {
        await rm(runDir, { recursive: true, force: true })
        if ((await readFile(canaryPath, "utf8")) !== canary)
          cleanupFailures.push("survival canary changed during child scratch cleanup")
      } catch (error) {
        cleanupFailures.push(`scratch cleanup: ${errorText(error)}`)
      }
    }
  }

  if (failure !== undefined) throw failure
  if (cleanupFailures.length > 0) throw new Error(cleanupFailures.join("; "))
})

function openAIStream(toolCall: boolean) {
  const id = "chatcmpl_token_budget_feasibility"
  const usage = {
    prompt_tokens: toolCall ? 5 : 2,
    completion_tokens: toolCall ? 3 : 2,
    total_tokens: toolCall ? 8 : 4,
    ...(toolCall
      ? {
          prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 1 },
          completion_tokens_details: { reasoning_tokens: 1 },
        }
      : {}),
  }
  const chunks = toolCall
    ? [
        { id, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: null },
        {
          id,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_feasibility_noop",
                    type: "function",
                    function: { name: toolName, arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          usage: null,
        },
        { id, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: null },
        { id, choices: [], usage },
      ]
    : [
        { id, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }], usage: null },
        {
          id,
          choices: [{ index: 0, delta: { content: "unrelated Session remains healthy" }, finish_reason: null }],
          usage: null,
        },
        { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
        { id, choices: [], usage },
      ]
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  })
}

async function captureStream(
  stream: ReadableStream<Uint8Array>,
  chunks: string[],
  onLine?: (line: string) => void,
) {
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

function parseJsonLines(value: string) {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line))
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)
}

function sanitizeOutput(value: string, root: string, runDir: string) {
  return value
    .replaceAll(serverPassword, "[redacted]")
    .replaceAll(providerApiKey, "[redacted]")
    .replaceAll(runDir, "<run>")
    .replaceAll(root, "<workspace>")
}
