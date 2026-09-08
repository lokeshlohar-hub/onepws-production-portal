# ONEPWS Portal — Code Patterns & Gotchas

Concrete, code-level traps specific to this codebase, gathered across many
sessions of working on it. These are still relevant with direct file
access (Claude Code) even though the PowerShell-copy-paste workflow itself
is now obsolete.

## JavaScript gotchas in this codebase

- **`||` vs `??`:** `value || fallback` silently discards an intentional
  `0`. This codebase has board quantities, achieved quantities, and other
  fields where `0` is a real, meaningful, valid value (e.g.
  `board_qty = 0` means "shares another line's board", not "unset"). Use
  `??` wherever such a field is read, not `||`.
- **IST timezone trap:** `.toISOString().split('T')[0]` rolls a date back
  one calendar day for users in IST (UTC+5:30), because `toISOString()`
  converts to UTC first. Always extract local year/month/day fields
  directly instead (`date.getFullYear()`, `date.getMonth()`,
  `date.getDate()`) when the intent is "today's date as the user sees it."
  This bug recurred at least three times across sessions before being
  consistently caught.
- **`async`/`await` propagation:** when converting a synchronous helper
  (e.g. `confirm()`/`prompt()`) to an async wrapper (for Electron
  compatibility via `electronConfirm`/`electronPrompt`), every function in
  the call chain up to the event handler must also become `async`/await
  it. A missed one caused a real login failure mid-session previously.
- **A plain (non-async) function that throws mid-body silently skips
  everything after it in its caller**, even if the caller doesn't
  `await` it and even if later statements look unrelated. This matters a
  lot in `confirmQcDecision()` → `processQcDecision()`
  → `checkAutoOpenHandover()`: if anything inside `processQcDecision()`
  throws, the handover auto-popup trigger (which runs right after it in
  the same function) never executes, even though the QC decision itself
  may have already succeeded and displayed correctly. If a feature that
  depends on "run right after X" mysteriously stops firing sometimes,
  check for an uncaught throw in X before assuming the trigger code
  itself is broken.
- **Client/server logic duplication (see ARCHITECTURE.md).** At least
  `refreshProjectProgress()` and `effectivePlanDate()`/
  `getEffectivePlanDate()` are independently implemented on both the
  frontend and backend, explicitly commented as "mirrors" of each other.
  Any bugfix to shared business logic needs to be applied in both places.
- **`setTimeout(100ms)` is required, not decorative,** for restoring
  scroll position after `renderAdmin()` rebuilds `innerHTML` — both
  `requestAnimationFrame` and `MutationObserver` were tried and failed,
  because the DOM mutates twice about 37ms apart during that specific
  re-render.
- **A blank/stuck "welcome" or loading screen after an edit** almost
  always means an extra (or missing) closing `}` from a copy-paste/
  splice error. Check the exact line number reported in the browser
  console's `Uncaught SyntaxError`.

## Naming/ID conventions

- Project SQL primary key: `PRJ-XXXX` (e.g. `PRJ-0015`). Human-facing
  project number (what appears on paperwork, what users search by):
  `sap` column, format like `CD-26-27-10048`. **These are different
  values on the same row** — don't confuse them when writing queries or
  API calls.
- BOM line ID: `BL-XXXXX` (e.g. `BL-00578`).
- Backend JSONB keys are snake_case (`qc_approved`, `board_qty`); the
  equivalent frontend in-memory object keys are camelCase (`qcApproved`,
  `boardQty`). There is a normalization/mapping layer between what's
  stored raw in Postgres and what the loaded frontend objects expose —
  when grep-ing for a field, check both spellings depending on which side
  of the app you're looking at.
- `stageToWorkstation`-style mapping objects have previously broken from
  naming mismatches as subtle as a missing word (e.g. `'PU Casting'` vs.
  the real stage name `'PU Casting Unit'`, or `'Cleaning'` vs. `'Cleaning
  Unit'`). When a routing/stage lookup silently returns nothing, suspect
  an exact-string mismatch before suspecting the surrounding logic.
- `QC_GATE_STAGES` is a hardcoded `Set` of stage names that represent QC
  checkpoints rather than real production stages (`'In-Process QC'`,
  `'Final QC'`) — used by `getFinalProductionStage()` to find a BOM line's
  true last *production* stage (as opposed to its last *route entry*,
  which might be a QC checkpoint). If a new QC-checkpoint-style stage
  name is ever introduced in routing config, it needs to be added here
  too, or "last stage" detection for that route will be wrong.

## UI/CSS gotchas

- Several CSS classes exist **specifically to hide certain columns on one
  table only**, while the same underlying data is shown normally
  elsewhere (Route Card PDF, Reports, other detail views). Known example:
  `.bom-col-uom`, `.bom-col-profile`, `.bom-col-route` — all
  `{display:none}` on the New Project Entry BOM table specifically. If a
  column "isn't showing" anywhere despite the row-building JS clearly
  constructing a `<td>` for it, grep for a CSS rule with that class name
  and `display:none` before assuming a JS bug.
- Checkbox-driven bulk-select tables use **separate, parallel selection-
  state objects** for mutually exclusive purposes on the same visual
  table (e.g. `_bomSelState` for "select not-yet-complete lines to
  advance to their next stage" vs. `_handoverSelState` for "select
  already-complete lines to notify handover for"). They deliberately do
  not share state, because a row can only ever be eligible for one of the
  two actions at a time (complete vs. not-complete). When adding a third
  bulk action to an existing table, prefer adding a new parallel state
  object over trying to overload an existing one.
- Row **dimming** (`opacity:.5`) and a checkbox being **enabled** are two
  separate, independently-controlled concerns on the same row — don't
  assume that making a checkbox clickable should also brighten the row's
  opacity, or vice versa. They can and do need to move independently
  (this exact conflation caused a real regression during the Handover
  Notification build).

## Editing conventions worth continuing

- Real production-data writes always get an **on-demand `pg_dump` backup**
  immediately before the write, in addition to the standing nightly
  backup — cheap insurance given how irreversible some of these changes
  are (e.g. TAT recalculation touching every project's planned deadline).
- Backend service restarts after a `productionEngine.js` or `server.js`
  change are always followed by tailing `backend-stdout.log` (and
  `backend-stderr.log`) to confirm `onepws-backend listening on port
  3000` appears as the final line with nothing else in between — a
  service reporting `SERVICE_RUNNING` immediately after NSSM's restart
  command doesn't by itself prove the app didn't crash and get
  auto-restarted by something else.
- Before any multi-line replace, re-fetch the *actual current* file bytes
  rather than trusting a paste from earlier in a long conversation — this
  file changes fast, and stale assumptions about line numbers or exact
  text are the single most common cause of a failed match.
