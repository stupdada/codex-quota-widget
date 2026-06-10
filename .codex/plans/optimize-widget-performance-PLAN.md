# Execution Plan

## task
- Slug: optimize-widget-performance
- Created: 2026-06-10 08:34:38 +0800

## original request
Implement cache-first startup, main-process refresh scheduler, hidden-state resource reduction, throttled compact interactions, narrower packaged assets, and compact resize stability

## assumptions
- The app remains an Electron tray/widget app; no framework migration is in scope.
- The visible compact widget should keep its current behavior, while hidden-to-tray may reduce renderer lifetime.
- Cache-first startup may show the last successful quota briefly, then replace it with a live refresh result.

## non-goals
- Do not redesign quota semantics or pace advice.
- Do not change the visual design except where needed to stabilize resize behavior.
- Do not add alternate quota providers or fake quota data.

## scope
- Main process quota state store with cache, in-flight request coalescing, scheduled refresh, and hidden-state lower-frequency refresh.
- Single-instance process guard and delayed BrowserWindow release after hiding to tray.
- Renderer subscription to main-process quota state instead of renderer-owned polling.
- Throttled compact resize/move IPC and stale scale-response suppression during active resize.
- Package file whitelist limited to runtime assets.
- Focused tests for quota store behavior.

## implementation phases
- Inspect current project state.
- Implement the smallest correct milestone.
- Run validation.
- Update ledger and handoff.

## key files and modules
- `src/main/quota-store.js`
- `src/main/main.js`
- `src/main/preload.js`
- `src/renderer/renderer.js`
- `package.json`
- `scripts/verify-quota-store.js`

## validation
- `node -c` for changed JavaScript files.
- `npm.cmd test`
- `npm.cmd run build:dir`
- Packaged app smoke/resource sample if build succeeds.

## fallback policy
- Default: no speculative fallback.
- Allowed guards: only user-required, contract-required, observed-failure, state/data-safety, security, or established project-convention guards.
- Rejected fallback paths: broad silent catches, fake defaults, unrequested legacy compatibility, backup providers, hidden degradation, and untested retry paths.

## risks
- none known yet

## worker boundary
- Main session owns architecture, boundaries, and review.
- Worker executes only the approved plan when explicitly started.

## thread worker mode
- For S3 project work, use a Codex project thread, not a projectless thread.
- Use worktree environment for code changes.
- Use local environment only for read-only exploration or accepted shared-workspace risk.
- Main session owns review and merge decision.
