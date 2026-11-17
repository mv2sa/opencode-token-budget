# OpenCode token-budget plugin

## Observable outcome

An ordinary root Session and its native descendants share reported-token containment. Once the configured base ceiling is reached, no additional supported logical generation is admitted. A user can explicitly allocate +25% more capacity only to a selected Session; other Sessions cannot consume that override. No native Core patch or live installation is required.

## Agreed policy

- Count non-cached input + visible output + reasoning + cache read + cache write, without double counting.
- Reported-token ceiling may overshoot for requests already underway. Do not claim exact provider billing or physical retry accounting.
- Use existing persistent native usage and plugin-private JSON storage; no new Core migration or permanent owner/tombstone ledger.
- Gate before Session-bound model preparation. Budget pause persists; ordinary prompts/wakeups/reloads do not replenish it.
- Preserve completed output and running CI/tool work. At the boundary, pause new generation rather than forcibly cancelling all work.
- No LLM-generated wrap-up after the limit.
- Only explicit user commands grant more. A +25% adjustment is Session-ID-local, not a global or inherited family-wide raise. It never resets usage and has no wall-clock expiry.
- Existing families may be attached explicitly with a baseline; new configured roots start a budget automatically.
- Unknown usage is not free. State the support/uncertainty honestly; do not advertise unaccounted generation as protected.

## Configuration

The selected default base is **40,000,000 reported tokens**. It is a default, not a fixed ceiling: a validated public plugin option `tokenCeiling` can select another positive safe integer. Invalid values must fail clearly rather than disabling enforcement.

Snapshot the chosen base in each new family's stored budget. Changing the configured default affects future families, not existing ones and not their Session-local grants. `/budget start <tokens>` can explicitly attach an existing family with a current-usage baseline; it must not silently replace an existing budget. No global settings are changed by a +25% command.

## Session-local grant arithmetic

The user chose to carry existing overshoot. Let `N` be the unchanged base ceiling, `U[s]` the counted usage of each member, and `F = sum(U[s])`. A grant is keyed by the exact selected Session ID and holds only `{ offset, ceiling }`.

- Grants are available only when that Session is budget-blocked; no deferred pre-ceiling credit machinery.
- First grant: `offset = F - U[s]`; `ceiling = ceil(1.25 * N)`.
- Later grants: keep `offset`; compound `ceiling = ceil(1.25 * ceiling)`.
- Once the shared base is exhausted, only a granted Session with `U[s] + offset < ceiling` can generate.
- Its remaining allowance is `max(0, ceiling - offset - U[s])`. Later sibling reports cannot consume it.
- Do not subtract override usage from `F`, raise `N`, copy grants through family discovery, reset usage, or issue automatic grants.

Example: base100,000; family105,000; selected30,000. The first grant has offset75,000 and local reference ceiling125,000, leaving20,000. A sibling's later10,000 changes no selected allowance; selected10,000 consumes10,000. A second blocked grant compounds to156,250 and carries the selected Session's own overshoot.

The read-only usage analysis and parent rerun are preserved in `artifacts/usage-analysis`. The user selected a custom40,000,000 default instead of the measured averages. Tiny thresholds remain appropriate for tests. No live installation or configuration was changed.

## First milestone — gate feasibility

Use the public V2 plugin API and an unmodified host. A tiny fixture plugin reads real reported Session usage, permits the first controlled model response, then rejects the next preparation at the threshold. Observe the actual provider request count, native terminal state, blocked future prompt/wake behavior and continued health of an unrelated Session. No mock admission function or candidate `SessionInference` service.

This milestone passed both specialist and parent runs on the public OpenCode CLI2.2.5, with2 cases/41 assertions/zero failures. The budget Session made1 provider request; automatic and manual continuation were denied before another request, completed tool work remained, and an unrelated Session succeeded with1 request. The host exited and its listener closed. Public-package source/binary identity and reports are preserved in `artifacts/feasibility`; the reference source archive was not the runtime.

Production implementation is now unblocked. The Session-local arithmetic is independently checked; cumulative usage through public `Session.Info.tokens`, family discovery, persistence and fork-counter behavior still need production integration proof. Do not scan current transcript as the authoritative lifetime meter.

## Proposed small layout

- `src/index.ts`: public SDK hooks and user commands.
- `src/budget.ts`: family/accounting/storage and Session-local overrides.
- `test/`: portable unit and real-host integration proofs.
- `.cache/host/`: owned unmodified host/development staging, never runtime dependency.
- `artifacts/`: immutable acceptance reports and identity receipts.

## Delivery hold

The output is a reviewed, built plugin/package and verification evidence. The user authorized an MIT-licensed GitHub repository at `mv2sa/opencode-token-budget`: create it private first, commit/push only after final tests and independent review, then make it public once validated. No usage-analysis data, runtime logs, credentials, dependencies or cached host binaries may be committed. Public source publication is separate from plugin installation.

Installation/configuration/activation are deferred to the coordinated update. No model/provider routing, npm publishing or old safeguard changes are authorized by this task.
