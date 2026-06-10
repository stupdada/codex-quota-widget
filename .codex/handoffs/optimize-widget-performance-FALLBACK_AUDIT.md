# Fallback Audit

## task
- Slug: optimize-widget-performance
- Updated: 2026-06-10 08:46:35 +0800

## scope
- Mode: staged
- Files inspected: 5

## policy
- Default: no speculative fallback.
- Allow guards only when required by user request, existing contract, observed failure, state/data safety, security, or established project convention.
- Prefer explicit validation and clear failure over silent defaults, broad compatibility branches, or unrequested degradation paths.

## findings
- `medium` `silent-default` at `src/main/main.js:303`
  - code: `return null;`
  - required justification: What concrete known failure or contract requires this guard?
- `medium` `silent-default` at `src/renderer/renderer.js:331`
  - code: `if (!Number.isFinite(number)) return null;`
  - required justification: What concrete known failure or contract requires this guard?
- `medium` `silent-default` at `src/renderer/renderer.js:407`
  - code: `const quota = snapshot?.quota || null;`
  - required justification: What concrete known failure or contract requires this guard?
- `medium` `silent-default` at `src/renderer/renderer.js:408`
  - code: `const error = snapshot?.error || null;`
  - required justification: What concrete known failure or contract requires this guard?
- `medium` `silent-default` at `src/renderer/renderer.js:434`
  - code: `const message = error?.message || "";`
  - required justification: What concrete known failure or contract requires this guard?

## accepted guards
- `src/main/main.js:303` is required by the new hidden-window release lifecycle: after hiding to tray the BrowserWindow may be destroyed intentionally, and callers must branch on no live window.
- `src/renderer/renderer.js:331` predates this task and remains required because quota/pace windows can omit optional numeric marker values.
- `src/renderer/renderer.js:407` and `src/renderer/renderer.js:408` are required by the explicit loading contract: a quota state can be loading with no quota and no error before the first live read.
- `src/renderer/renderer.js:434` predates this task and remains required because IPC failures and thrown values may not always carry an Error-shaped message.

## rejected fallbacks
- none recorded by the scanner; remove or justify suspected speculative fallbacks during review.

## decision
- Result: pass-with-risk
- Counts: high=0, medium=5, low=0
