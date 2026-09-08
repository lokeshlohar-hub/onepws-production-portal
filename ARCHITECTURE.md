# ONEPWS Portal — Architecture

## High-level shape

```
┌─────────────────────────────────────────────────────────────┐
│  Electron desktop wrapper (C:\onepws-electron\)              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  index.html (~24,000+ lines) -- single-file frontend │    │
│  │  Vanilla JS, no framework, no build step.             │    │
│  │  Served statically by the Express backend below.      │    │
│  └─────────────────────────────────────────────────────┘    │
└───────────────────────────┬───────────────────────────────────┘
                             │ HTTP (localhost or LAN IP), REST-ish JSON API
┌───────────────────────────▼───────────────────────────────────┐
│  Node.js / Express backend  (C:\onepws\backend\src\)          │
│  - server.js: route registration, health check                │
│  - routes/*.js: one file per resource area                    │
│  - lib/productionEngine.js: THE authoritative production/QC   │
│    state-machine -- see "Critical file" section below         │
└───────────────────────────┬───────────────────────────────────┘
                             │ pg (node-postgres)
┌───────────────────────────▼───────────────────────────────────┐
│  PostgreSQL  (db: onepws_prod, user: onepws_app)               │
└─────────────────────────────────────────────────────────────┘

  Sidecar services (also NSSM Windows services):
  - ONEPWSExtractor: Python/Flask/waitress, PDF BOM extraction (Wood only),
    localhost-only, port 8082.
  - ONEPWSUpdates: static file server for Electron auto-update artifacts,
    port 8080.
```

## Frontend: `index.html`

- One enormous static HTML file with an inline `<script>` containing all
  application JavaScript (tens of thousands of lines). No React/Vue/Angular,
  no bundler, no npm build step for the frontend itself.
- Served live by the backend (likely `express.static` or an equivalent
  catch-all route) — editing the file and hard-refreshing the browser/
  Electron window is enough to see changes; no compile/deploy step.
- Global mutable state lives in a few well-known objects:
  - `DB.*` — arrays of loaded records (`DB.projects`, `DB.rejectLog`,
    `DB.handoverLog`, `DB.auditLog`, etc.), populated from the backend API
    on load and mutated in place as the user works.
  - `M.*` — "master data" / admin-configured settings (`M.tatRules`,
    `M.componentRouting`, `M.categories`, `M.handoverRecipients`, etc.),
    persisted server-side in the generic `admin_config` table.
  - `CUR_PROJ`, `CUR_BOM_LINE` — "currently open in a detail view" pointers.
  - Various small `_xyzSelState` objects tracking checkbox multi-select
    state for specific bulk-action tables (e.g. `_bomSelState` for "Proceed
    to Stage", `_handoverSelState` for bulk Notify Handover — these are
    **deliberately separate, parallel state objects**, not shared, because
    they gate mutually exclusive row states).
- A recurring, important pattern: **client-side and server-side
  re-implement the same computation independently in a few places**
  (notably project/segment progress calculation). This is a known source of
  bugs — see "Known architectural risk" below.
- Styling: hand-rolled CSS (no Tailwind/framework), CSS custom properties
  for theming (`var(--text-muted)`, `var(--accent)`, `var(--surface)`,
  etc.).
- A handful of CSS classes exist purely to **hide certain `<td>` columns on
  one specific table** while leaving the same data visible elsewhere (e.g.
  `.bom-col-uom`, `.bom-col-profile`, `.bom-col-route` on the New Project
  BOM entry table only) — grep for the class name's `{display:none}` rule
  before assuming a column doesn't render anywhere in the app.

## Backend: `C:\onepws\backend\src\`

- `server.js` — Express app setup, middleware, and `app.use('/api/x',
  xRoutes)` registration for every route module. Also exposes a `/api/health`
  endpoint whose response body is a **self-documentation object listing
  route names** — useful for a quick "what's actually registered" sanity
  check, but it is not an enforcement/authorization allowlist; actual
  routing is controlled entirely by the `app.use()` calls.
- `routes/*.js` — one file per resource: `projects.js`, `qc.js` (mounted at
  `/api/bom-lines`, handles per-BOM-line reads and the QC decision
  endpoint), `qcLog.js` (new — complete QC history), `handover.js`,
  `tatOverride.js`, and others not yet inspected in depth (job work
  outward, tool inventory, maintenance/breakdown log, calibration, DMS
  documents, mistake register, why-why log, todo list — these exist per the
  database table list but their route files haven't been read this
  session).
- `lib/productionEngine.js` — **the most important file in the backend.**
  See below.
- Auth: `requireAuth` / `requireRole` middleware, role/department checks
  matching the frontend's `hasPermission()` / `isProductionAdminUser()`-
  style gates. Auth appears to be cookie/session or token based (existing
  API calls from the frontend use a generic `apiRequest()` wrapper).
- `.env` file holds DB credentials and any other secrets — check what's in
  there before assuming what's configured (SMTP was NOT configured as of
  this handoff; see "Open items" below).

### Critical file: `lib/productionEngine.js`

This file is the **authoritative source of truth** for what happens when
production events occur — not the frontend. Two functions matter most:

- **`refreshProjectProgress(client, projectId)`** — recomputes a project's
  overall `progress` percentage from all its `bom_lines`, and — critically —
  is also where `wood_status` / `ext_status` / `act_wood` / `act_ext` /
  `dly_wood` / `dly_ext` get stamped when a segment completes. This function
  was previously buggy: it only stamped completion when the **combined**
  wood+extrusion progress reached 100%, not each segment independently. It
  has since been fixed to compute wood and extrusion progress separately
  and gate each segment's stamping on its own 100%, but **a parallel,
  independently-maintained copy of the same logic exists client-side** in
  `index.html`'s own `refreshProjectProgress()` — the two were written to
  "mirror" each other and both had to be fixed separately when the bug was
  found. Any future change to completion-stamping logic must be checked
  against **both** copies.
- **`processQcDecision(...)`** — the real QC approve/reject handler,
  called from the `/api/bom-lines/:lineId/qc-decision` route. Handles
  approve/reject quantity bookkeeping, rework-line spawning on rejection,
  writes to `reject_log` (rejections only) and now also to `qc_log` (every
  decision — see DATABASE.md), and calls `refreshProjectProgress()` at the
  end.
- **`eligibleInputQty(b, stageName)`** — computes how much quantity is
  legally available to work on at a given stage, based on the previous
  stage's approved quantity (or, for board-based Wood stages, the line's
  own `board_qty`, or `0` for a line configured to share another line's
  board via `board_source_line_id`). This function is central to
  everything the operator is allowed to submit — treat it as extremely
  sensitive. A subtlety: a Wood BOM line with `board_qty = 0` and no
  `board_source_line_id` is a **stuck/orphaned line** (this happened for
  real — see Known Issues) — it will show zero eligible quantity at every
  downstream stage forever, which a naive "is this line done?" check can
  misinterpret as "complete" rather than "blocked." `currentActiveStageOfLine()`
  (frontend) was patched to guard against exactly this misclassification.

## Electron wrapper

- Separate project at `C:\onepws-electron\`, packaged with `electron-builder`
  as an NSIS installer.
- Self-hosted auto-update: version bump via `npm version`, `npm run dist`,
  then copy the resulting `.exe` + `.blockmap` + `latest.yml` into
  `C:\onepws\updates\`, served by the `ONEPWSUpdates` NSSM service.
- `dialog-helpers.js` provides `electronPrompt` / `electronConfirm` wrappers
  so the same code works whether running inside Electron (no native
  `window.prompt`/`confirm`) or a plain browser.
- Seqrite Endpoint Protection (antivirus) on the build machine can throw
  `EPERM` during Electron packaging; folder exclusions already exist for
  `C:\onepws-electron\` and `C:\electron-builder-cache\`.

## Known architectural risks / things a new session should watch for

1. **Client/server logic duplication.** At least two production-critical
   functions (`refreshProjectProgress`, and likely others) are
   independently reimplemented on both sides. Any bugfix to "how progress /
   completion is calculated" needs to be checked and applied in both
   places, or the two will silently drift apart again (this already
   happened once).
2. **`mailto:`-based email is a hard dead end for rich formatting.**
   The Handover Notification feature currently opens the user's default
   mail client via a `mailto:` link with a plain-text body. `mailto:`
   cannot carry HTML or attachments/embedded images — this is a protocol
   limitation, not a bug, and no amount of HTML generation on our side can
   fix it. A migration to real SMTP/API-based sending was **just agreed
   with Ankit** and is the next planned piece of work (see Open Items).
3. **PDF BOM extractor gaps.** The Python/PyMuPDF extractor that
   auto-populates Wood BOM lines from a PDF drawing sometimes fails to
   compute `board_qty` for some extracted lines (leaves it at `0` with no
   `board_source_line_id`), silently creating "stuck" lines that can never
   show real progress. This was patched as a one-time data fix; the root
   cause inside the extractor service itself was never investigated.
4. **Heavy reliance on exact string matching for edits.** (This is a
   note about *this session's own workflow*, less relevant once Claude
   Code has direct file access — but worth knowing: many strings in
   `index.html` contain real Unicode em-dashes, emoji, and other non-ASCII
   characters that look like garbled mojibake when displayed through a
   Windows terminal's default encoding. Always read a file's actual bytes
   directly (not from a possibly-stale paste) before editing it.)
5. **Single giant HTML file.** There is no module system, no code
   splitting, and (as far as this session found) no automated test suite.
   Every change was verified manually via browser console checks and live
   testing. If the Capacitor/React tablet rebuild goes forward, this is
   probably the single biggest thing worth reconsidering — the codebase
   would benefit enormously from being decomposed before or during that
   rewrite, rather than porting the 24,000-line single-file pattern as-is.

## Open items handed off mid-flight

- **Real SMTP email sending** — agreed with Ankit, not yet built. Sending
  account: `production@workspace.com`. Need the actual SMTP host/port/SSL
  settings (Ankit was mid-lookup in Windows Live Mail's account settings
  when this handoff document was requested) and the account password
  (`production`, per Ankit — **strongly recommend prompting him to change
  this to something stronger before wiring up automated sending with it**).
  Plan was to use `nodemailer` on the backend, build a real HTML email
  template (table-based markup for Outlook compatibility, since Outlook
  renders HTML email via Word's engine and needs `<table>`-based layouts
  rather than modern CSS), and switch the "Send" button in the Handover
  Notification modal from `mailto:` to an actual backend send call —
  while preserving the existing recipient-picker, CC, review-before-send,
  and audit-logging behavior exactly as-is.
- **QC History Export button** — the "Full History" tab was rebuilt to
  show combined Pass+Reject records with server-side filtering, but its
  Export button was deliberately left wired to the old rejection-only
  export function, as a known follow-up.
- **Several pre-existing minor bugs** noted but not fixed this session
  (see project memory / prior handoff notes for the full list) — JWO
  search UI polish, Edit BOM delete-warning for parent board-planning
  lines, Bulk Stage Update stale checkbox selections, a console error on
  the Stage-wise date field, and a recurring IST/UTC timezone display
  quirk.
