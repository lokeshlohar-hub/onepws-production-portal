# ONEPWS Production Planning & Control Portal — App Overview

## What this is

A custom-built manufacturing management system for **ONEPWS Private Limited**
(formerly Pyrotech Workspace Solutions), an India-based furniture and
aluminum-extrusion manufacturer. It manages the full production lifecycle of
a customer project: from BOM (Bill of Materials) entry, through machine-stage
routing and QC clearance, to dispatch and reporting — for two parallel
manufacturing segments:

- **Wood** (furniture components — panels, shutters, table tops, legs, etc.)
- **Extrusion** (aluminum profile components)

A single project can have Wood only, Extrusion only, or both segments
running in parallel, each tracked and completed independently.

## Who uses it

Roughly 15 concurrent shop-floor and office users, in these roles:

- **Superadmin** — full access, no restrictions (e.g. "Admin User" account).
- **Admin**, scoped by **department** — Production, Quality, Maintenance,
  Other. Department matters: some features (e.g. the Handover Notification
  auto-popup) only trigger for specific departments (currently Production
  and Quality).
- **Viewer** — read-only.

Named individuals referenced during development: operators **Gopi Lal
Dangi** and **Ravi Nagda**; QC inspector **Bhagwat Singh**; a QC-department
login used day-to-day is literally named **"Inprocess QC."**

## Core business workflow

1. **New Project Entry** — SAP-style project number, customer, PM/Engineer,
   Product Type (CD / CR / AD / R&D / IOC) and Category (Cat 1/2/3, or none
   for IOC), file-received dates per segment. TAT (turnaround time) rules —
   configured per Product Type × Category in Admin — auto-calculate the
   planned dispatch date for each segment from its file-received date.
2. **BOM entry** — per segment, line items with quantity, size, color/finish
   (now with autocomplete), special characteristics, and (for Wood) board
   planning — how many physical boards are needed to cut the components,
   with support for one BOM line sharing another line's board.
3. **Routing** — each BOM line follows a sequence of machine/process stages
   (e.g. Hot Press → Beam Saw → Edge Banding → Cleaning unit for Wood;
   Extrusion Cutting → Drilling → Packing for Extrusion), auto-assigned from
   Admin-configured routing rules per component type.
4. **Stage-wise production tracking** — operators log quantities moving
   through each stage. Each stage requires **QC clearance** (pass/reject/
   partial) before the approved quantity becomes eligible for the next
   stage. Rejections can trigger an automatic **rework line** spawned back
   to the first stage.
5. **Completion & Handover** — when a BOM line's own last real production
   stage (skipping QC-checkpoint-only stages) is QC-approved for its full
   quantity, the segment can be marked complete and a **Handover
   Notification** (email to a configured recipient, reviewed before sending)
   can be triggered — automatically after single or bulk QC approval, or
   manually at any later point via a per-component button or a multi-select
   checkbox list.
6. **Reporting** — OTD (on-time-delivery) %, delay analysis, capacity
   planning, QC/quality history (pass + reject), maintenance, and MIS
   reports, most exportable as landscape PDFs with a document-control header
   for the two most formal report types.

## Current deployment (as of this handoff)

- Single Windows Server (`sys160`, static LAN IP `192.168.100.160`).
- Frontend is a single, very large `index.html` (24,000+ lines) served
  live/statically by the Node backend — no build step, edits take effect on
  hard-refresh.
- Backend: Node.js/Express + PostgreSQL, running as an NSSM Windows service.
- Distributed to shop-floor PCs as an **Electron desktop app** with
  self-hosted auto-update (NSSM-served update file server).
- A separate small Python/Flask service does PDF-based BOM auto-extraction
  for Wood-segment BOM entry (parses a PDF drawing, pre-fills component
  rows).
- Nightly `pg_dump` backups, 30-day retention.

## Planned next phase (the reason for this handoff)

Ankit is moving active development from a chat-based "paste PowerShell
output back and forth" workflow into **Claude Code**, working directly
against the real files in a git repo. The next phase of the roadmap is:

- **Database migration to Supabase** (managed Postgres) — a new account will
  be created.
- **Hosting migration to Google Cloud Run** for the backend.
- **A tablet app** (Android APK) — likely via **Capacitor** wrapping the
  existing web frontend, or a React-based rebuild — exact approach still to
  be decided with the new Claude Code session.

None of this migration work has started yet as of this document. The
current system described above (Windows/NSSM/Electron/on-prem Postgres) is
the **starting point**, not the target architecture.

## Working style Ankit expects (carried over from this session)

- **Evidence before action.** Every bug fix and change was diagnosed by
  pulling real file contents, real SQL query results, or real console
  output first — never guessed at.
- **Small, verified, reversible changes.** Backups before every write
  (both file backups and on-demand `pg_dump` before schema/data changes),
  guarded edits that abort loudly on any ambiguity, verification queries
  after every change.
- **Don't disturb what already works.** Repeatedly, Ankit has asked for a
  fix or feature to be added *without* touching adjacent, currently-working
  logic (routing, QC, BOM, capacity, production). New capability was
  consistently built as additive, parallel code paths rather than by
  editing fragile existing functions in place, whenever that was feasible.
- **Ankit is non-technical.** He does not read or write code himself. He
  needs exact, copy-pasteable instructions and plain-language explanations
  of *why* something broke and what a fix will and won't affect. This will
  presumably change somewhat once Claude Code has direct file access, but
  the plain-language, confirm-before-you-proceed communication style should
  carry over.
