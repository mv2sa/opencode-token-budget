# Token-budget plugin workspace

This is a standalone OpenCode V2 server plugin. Do not modify OpenCode Core, OMOS, their old candidate worktrees, or user configuration.

## Scope and holds

- Build and verify locally. Do not install or activate the plugin in the live setup; installation waits for the coordinated update.
- Source commits/pushes are authorized only for this standalone repository after final tests and independent review. Its GitHub repository starts private and may become public once validated. No issues/PRs/merges, live-service discovery/restarts, model/fallback changes, npm publishing or paid provider requests are authorized.
- The standalone repository is MIT-licensed. Exclude private usage reports, logs, credentials, dependencies and cached host binaries from source commits.
- Development dependencies may be installed only in this workspace or its owned test staging, with private HOME/cache. Never write through dependency links into another checkout.
- Test against unmodified OpenCode, not the earlier inference-loop-safety candidate. Runtime dependencies must not import Core/Server internals.
- This is reported-token containment with possible in-flight overshoot, not physical-submission, billing, sandbox or distributed-ownership enforcement.

## Implementation

- Keep production code small; prefer the public Promise plugin SDK and existing storage/session APIs.
- No model-callable budget-grant tool, automatic limit increase, timer-based bypass, or model-generated ceiling wrap-up.
- A user +25% override is specific to the selected Session ID. Do not raise the global default or give other Sessions its allowance.
- Preserve completed work and already-running CI/tool work at a budget boundary. No forced background-process cleanup.
- Avoid `any`, unnecessary type assertions, aliased imports and speculative abstractions.

## Verification

- First prove a real plugin-loaded before-generation gate on an ordinary unmodified V2 Session.
- Use local fake providers, explicit private environments and authoritative lifecycle events; no arbitrary sleeps or live credentials.
- Portable tests: no user-specific absolute paths in test source and no import of private external test harnesses.
- Distinct owned scratch and output paths; preserve JUnit, source bindings and failure receipts. Settle owned servers/processes before cleanup.
- Run exact workspace scripts and independently verify nonempty reports. Passing unit tests alone does not prove the runtime gate.
- Keep native tests/builds and client artifacts of other work untouched. Respect the global command-scoped Git identity for any commit; source commits require the review and verification gates above.
