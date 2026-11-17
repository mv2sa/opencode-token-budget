# OpenCode token-budget plugin

Server-side reported-token containment for ordinary OpenCode V2 Sessions, without a Core patch. Source repository: [mv2sa/opencode-token-budget](https://github.com/mv2sa/opencode-token-budget). MIT licensed.

**Installation and activation are deferred to the coordinated update.** This project is not published to npm. The configuration below illustrates a checked-out local plugin directory; do not install an unrelated similarly named npm package. Compatibility is currently qualified against the public OpenCode **2.2.5** Linux host. Requalify against the coordinated-update target before activation.

Standalone OpenCode V2 Promise server plugin. It uses the public `@opencode/plugin` API, native cumulative `Session.Info.tokens`, and plugin-private JSON storage; it does not require a Core patch. The default base ceiling is **40,000,000 reported tokens**. A configured `tokenCeiling` option selects another positive safe integer and is snapshotted for each new family.

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-token-budget",
      "options": { "tokenCeiling": 40000000 }
    }
  ]
}
```

The configured value affects future budget families only. Existing families retain their saved base ceiling. New root Sessions start a family automatically; existing families can be explicitly attached with `/budget start <tokens>`, which snapshots each current member's native cumulative usage as a non-charged baseline and refuses to replace an already attached budget. Only usage growth after attachment consumes that window; members discovered later start at a zero baseline.

## Commands

- `/budget status` reports the selected Session's family usage, base, and local grant state without an LLM call.
- `/budget start <tokens>` explicitly attaches an unbudgeted existing family to the supplied positive safe-integer base.
- `/budget +25%` grants capacity only when the selected Session is blocked by its family budget. It does not raise the default or other Sessions' allowance.
- `/budget continue` grants another +25% only when needed and, if the selected Session now has room, sends the user's requested continuation as a normal counted prompt.
- `/budget stop` records a user-requested pause and may interrupt that Session's active execution. A budget boundary itself does not interrupt work already underway.

The before-generation gate covers supported Session-bound requests before provider dispatch, including auxiliary `title`, `compaction`, and `generate` preparation paths. Reported family usage comes from the Session's persistent cumulative `Session.Info.tokens`, not a transcript-window sum. Family totals use monotonic member high-water marks; parent and fork links are reconciled from public Session APIs. A +25% grant stores only the exact selected Session's `{ offset, ceiling }`: its own post-baseline growth consumes that capacity, while sibling, parent, child, and fork growth cannot spend it. Auxiliary calls consume budget only to the extent that the host includes them in its cumulative Session counters.

## Accounting limits

This is reported-token containment, not provider billing or physical-request enforcement. Requests already in flight may finish and overshoot. Retries are only gated where the public Session retry hook exposes them; the plugin does not claim hidden transport-attempt counts.

If the host reports zero, absent, malformed, or otherwise unusable usage for an actual completed model step, the family becomes accounting-unavailable and fails closed. A preparation-hook rejection or control-only terminal without a started model step is not treated as missing model usage. A deleted member with unresolved model work, or a completed step whose cumulative Session usage cannot be refreshed, also fails closed rather than becoming free capacity. Historical usage before an explicit `/budget start` remains in native counters as the baseline but does not consume the newly attached window. Provider work outside a Session, image generation, physical retries, billing, and distributed ownership are not guaranteed by this MVP.

The plugin never adds a model-callable budget-grant tool, automatic grant, reset, or generated wrap-up. A failed gate is reported through the host's normal Session execution error state with a static budget message.

## Local verification and packaging

Development and runtime verification use private local environments and loopback fake providers. The acceptance scripts are:

```sh
bun install --frozen-lockfile
bun run prepare:host
bun run typecheck
bun run test:unit -- --reporter=junit --reporter-outfile=artifacts/corrections/unit.xml
bun run test:feasibility -- --reporter=junit --reporter-outfile=artifacts/repository-readiness/feasibility.xml
bun run test:integration -- --reporter=junit --reporter-outfile=artifacts/corrections/integration.xml
bun run build
bun run verify:package
```

Installation or activation in the live OpenCode setup is deferred to the coordinated update. Package verification installs only into owned private staging and does not publish the tarball.

Development and CI currently use Bun **1.4.4**, Node.js **24.18.0**, and Linux. Host preparation downloads a pinned official source reference and public CLI into `.cache/host`; tests run the public CLI binary, not a modified source checkout or the user's live managed service. No provider credentials are required. The source reference is provenance information, not a claim that the published binary was rebuilt from that archive locally.

Tests cover actual plugin-loaded rejection, parent/child/fork accounting, selected-Session grants, fresh attachment baselines, reloads, missing usage, deletion, pre-send rejection, compaction, public Session generation, retry decisions, and preservation of running shell/CI work. The packaged export is checked in an isolated consumer, including exact MIT license bytes; that import smoke test is separate from the source-plugin real-host tests. Windows, real-provider behavior and live activation are not qualified by the Linux suite.

Personal usage analyses, runtime transcripts, test evidence, caches, downloaded hosts and package archives are excluded from Git. Preserve failure evidence locally, and clean only settled, owned successful scratch.
