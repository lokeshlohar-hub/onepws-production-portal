# ONEPWS Portal — Database Structure

PostgreSQL. Database: `onepws_prod`. App user: `onepws_app`.

This document separates what was **directly confirmed** this session (via
`\d tablename` or real query output) from what is **known to exist but not
yet inspected**. Treat the latter as a to-do for the new session — don't
assume column names for those tables without checking.

## Full table list (confirmed via `\dt`)

```
admin_config, bom_lines, breakdown_log, calibration_instruments,
daily_capacity, dms_documents, handover_log, job_work_outward,
job_work_outward_lines, mistake_register, project_edit_log, projects,
qc_log, reject_log, stage_log, tat_overrides, todo_list, tool_inventory,
tool_issue_log, users, why_why_log
```

---

## Fully confirmed schemas

### `projects`

The central table — one row per customer project.

| Column | Notes |
|---|---|
| `id` | PK, app-generated format like `PRJ-0015` |
| `sap` | Human-facing project number, e.g. `CD-26-27-10048` (customer/business ID, NOT the DB primary key) |
| `type` | Product Type: `CD`, `CR`, `AD`, `R&D`, or `IOC` |
| `category` | `Cat 1` / `Cat 2` / `Cat 3`, or null for IOC (single-rule type) |
| `customer`, `pm`, `eng`, `po`, `job_work_po`, `drawing_wood`, `drawing_ext`, `remarks`, `certifications` | header fields |
| `has_wood`, `has_ext` | booleans — which segments this project runs |
| `rec_wood`, `rec_ext` | file-received dates per segment |
| `plan_wood`, `plan_ext` | planned/TAT-calculated dispatch dates per segment |
| `act_wood`, `act_ext` | actual completion dates per segment — **null until that segment's own BOM lines are fully QC-approved through their true last stage** |
| `dly_wood`, `dly_ext` | delay in days (actual/today minus plan); negative = early. For a still-running segment this is a **live** running total updated by the backend on every QC-decision recompute, not a final number |
| `wood_status`, `ext_status` | `Running` / `Complete` (also `Hold` handled elsewhere) |
| `progress` | overall (combined wood+ext) percent complete, 0–100 |

**Known past bug (fixed):** `act_wood`/`act_ext`/`wood_status`/`ext_status`
were, before the fix, only stamped when *combined* progress hit 100%, not
each segment independently — meaning a segment with genuinely zero progress
could get wrongly marked "Complete" if the *other* segment alone reached
100% while this segment's BOM was still empty or in progress. If you ever
see a segment showing `Complete` with an actual-complete date but real 0%
progress in `bom_lines`, this is that bug recurring — check
`productionEngine.js`'s `refreshProjectProgress()` AND `index.html`'s
client-side copy of the same function; both must independently gate on the
segment's own progress, not the combined total.

### `bom_lines`

One row per BOM component line, belonging to a project + segment.

| Column | Notes |
|---|---|
| `line_id` | unique ID, format `BL-00578` |
| `project_id` | FK to `projects.id` |
| `seg` | `wood` or `ext` |
| `item` | component name, e.g. `Shutter`, `Basewood` — **not unique per project**; the same item name can legitimately appear multiple times (e.g. `LHS`/`RHS`, `FRONT`/`BACK` variants), disambiguated by `description` |
| `description` | free-text sub-identifier, e.g. `RHS`, `BACK LHS`, `TABLE TOP 2 LEFT` |
| `qty` | total quantity to produce for this line |
| `color_finish`, `l`, `w`, `t` (Wood), `profile` (Extrusion), `uom` | BOM detail fields |
| `route` | **JSONB array of stage-name strings**, in order, e.g. `["Hot Press","Beam Saw","Edge Banding Machine","Multi Boring","Cleaning unit"]` |
| `stage_data` | **JSONB object keyed by stage name.** Each stage's value has at least `qc_approved` (numeric, cumulative approved qty at that stage) and a `history` array of `{ts, ws, qty, action, operator}` entries logging every QC event at that stage. Raw DB key is snake_case `qc_approved`; the equivalent already-loaded client-side JS object exposes it as camelCase `qcApproved` — there is a normalization step between the two, so match key case to which side of the app you're reading from. |
| `board_qty` | (Wood only) number of physical boards planned for Hot Press / Beam Saw for this line. `0` is a **valid, meaningful value** meaning "this line's components come from another line's board" — but only if `board_source_line_id` is also set. A `board_qty = 0` with **no** `board_source_line_id` is an orphaned/stuck line that can never progress (see Known Issues) |
| `board_source_line_id` | FK-like reference (not an enforced FK as of this session) to another `bom_lines.line_id`, used for the "share a board with another line" feature |
| `components_released` | how many components have been released from the shared board's Hot Press stage into this line, for board-sharing lines |
| `is_rework`, `rework_of_line_id`, `spawned_rework_line_ids` | rework/rejection lineage tracking — a rejected quantity can spawn a brand-new BOM line sent back to the first stage |
| `created_at` | timestamp |

### `tat_overrides`

Manual overrides of a segment's planned deadline (e.g. customer-caused
delay, material shortage). One row per override event.

`id, project_id, segment, original_received, original_plan,
override_reason, reason_category, revised_start_date, revised_completion,
delay_days_added, responsibility_category, notes, created_by_name,
created_by, created_at`

When present, `revised_completion` supersedes the base `plan_wood`/`plan_ext`
for delay/OTD calculations — both the frontend's `effectivePlanDate()` and
the backend's `getEffectivePlanDate()` implement this lookup independently
(again, watch for logic drift between the two).

### `qc_log` (added this session)

Complete history of **every** QC decision (Pass, Reject, or Partial) — not
just rejections. Built specifically because the pre-existing `reject_log`
only ever recorded rejections, and Ankit wanted a full pass+reject history
with fast server-side date/segment/status/machine/project filtering.

`id, ts, date, project_id, proj_sap, customer, item, segment, stage,
workstation, approve_qty, reject_qty, qc_status, category, root_cause,
qc_person, qc_instrument, source_line_id`

- `stage` and `workstation` are currently always written as the same value.
- `qc_status` is `'Pass'`, `'Reject'`, or `'Partial'` (both approve_qty>0
  and reject_qty>0 in the same decision).
- Written unconditionally from `processQcDecision()` in
  `productionEngine.js`, alongside (not replacing) the existing conditional
  `reject_log` insert.
- Indexed on `project_id`, `date`, `qc_status`.
- API: `GET /api/qc-log` (filtered, current-month default) and
  `GET /api/qc-log/machines` (distinct stage list for a filter dropdown),
  both in `backend/src/routes/qcLog.js`.

### `users`

`full_name, role, department` confirmed (likely more columns — password
hash, id, created_at, etc. — not enumerated this session).

- `role`: `admin`, `superadmin`, or `viewer`.
- `department` (only meaningful for `admin` role): `Production`, `Quality`,
  `Maintenance`, `Other`, or null (superadmin has no department).
- Some feature gates check role+department together, e.g. the Handover
  Notification auto-popup only fires for `superadmin`, or `admin` with
  department `Production` or `Quality`.

---

## Partially confirmed

### `reject_log`

Confirmed to have (via displayed report columns, not a direct `\d` dump):
a date/timestamp, project reference, `item`, `stage`/`workstation`, `qty`,
`category`, `disposition` (e.g. `rework`), `status` (e.g. `Closed`),
QC person, QC instrument (+ due date), root cause, photo data, and a
rework-line-id back-reference. This table feeds the existing Pareto
Analysis and PPM Trend quality reports — **do not modify its schema or
insert logic without checking those consumers first.**

### `stage_log`

Has `project_id`, `ts`, `stage` (name string). **No segment column** —
less precise for backfill/analysis purposes than `bom_lines.stage_data`'s
embedded `history` arrays, which are segment- and line-specific.

### `handover_log`

Not directly inspected via `\d`, but its write contract is known from the
frontend's `apiCreateHandover(payload)` calls: `lineId, projectId, proj,
item, qty, uom, segment, finalStage, details (JSONB), department, email,
ccEmails, triggeredBy`. Required fields per backend validation: `lineId`,
`projectId`, `email`. One row is written **per component**, even for a
bulk/consolidated notification covering several components at once — there
is no multi-component array support in this table.

### `admin_config`

Generic key-value store: a `config_key` column and a JSONB `config_value`
column (exact column names not directly confirmed, but this is the
pattern referenced throughout the frontend, e.g. `persistAdminConfig
('tatRules')`, `persistAdminConfig('handoverRecipients')`). New config keys
are additive — no schema migration needed to add a new admin-configurable
setting.

---

## Not inspected this session — verify before relying on

`breakdown_log`, `calibration_instruments`, `daily_capacity`,
`dms_documents`, `job_work_outward`, `job_work_outward_lines`,
`mistake_register`, `project_edit_log`, `todo_list`, `tool_inventory`,
`tool_issue_log`, `why_why_log`.

These all exist and are presumably used by corresponding frontend
sections (Capacity Planning, Tool Inventory, Job Work Outward, Maintenance/
Breakdown Log, Calibration tracking, DMS document control, Mistake
Register / Why-Why analysis, a To-Do list feature, and a project-level
edit audit trail) — but their actual columns were never queried this
session. Run `\d tablename` on any of these before writing code that reads
or writes to them.
