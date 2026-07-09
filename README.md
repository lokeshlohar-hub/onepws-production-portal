# ONEPWS Production Control Portal

A single-file, self-contained production management portal for a furniture / interior
fit-out manufacturing operation, covering both Wood Production and Aluminium Extrusion
segments end to end — from project intake through stage-wise production, QC, maintenance,
calibration, tool inventory, and reporting.

**No backend, no build step.** The entire application — HTML, CSS, and JavaScript — lives
in `index.html`. Data is held in memory and resets on page refresh; there is no database or
server-side persistence. Chart.js is the only external dependency, loaded from a CDN.

## Modules

- **Dashboard** — cockpit view across OTD, Quality, Maintenance, Capacity, Shift and
  Calibration performance
- **Analytics & MIS** — quarterly OTD, TAT, and delay-contribution reporting
- **Master Project Tracker** — project-level status, filtering, and drill-down
- **New Project Entry** — BOM entry (Wood + Extrusion), certifications, auto TAT calculation
- **Stage-wise Production Updates** — component-level routing, stage entry, QC gating
- **Capacity Planning** — daily capacity, machine utilization, OEE, machine blocking,
  monthly planning, and Tool Consumption Tracking
- **Quality Control** — QC inspection queue, calibrated-instrument selection, reject/rework
  log with automatic rework-to-new-BOM-line logic
- **Maintenance** — breakdown entry, Why-Why RCA, preventive maintenance, MTTR/MTBF, and
  Tool Inventory Management (stock, issue, tool-life analytics)
- **Calibration Management** — instrument master, due-date scheduling, completion entry,
  compliance analytics
- **Reports & Export** — CSV/PDF report generation across all modules
- **Audit Trail** — ISO-compliance change log
- **Document Library (DMS)** — controlled document storage with revision history
- **Admin Panel** — master data configuration, plus **User & Permission Management**
  (role-based access control)

## Login & roles

The portal opens to a login screen. Seeded demo accounts:

| Role | Username | Password | Scope |
|---|---|---|---|
| Master Admin | `admin` | `admin123` | Full, unrestricted access |
| Admin (Production) | `prod.admin` | `prod123` | Tracker, New Project, Stage Updates, Capacity Planning |
| Admin (Quality) | `qc.admin` | `qc123` | Quality Control, Calibration |
| Admin (Maintenance) | `maint.admin` | `maint123` | Maintenance, Calibration, Tool Consumption |
| Viewer | `viewer` | `view123` | Read-only across all modules |

Master Admin can create additional users and configure module- and section-level
permissions (View / Create / Edit / Delete / Approve / Export / Print / Download) from
**Admin Panel → User & Permission Management**.

> This is a client-side access-control simulation consistent with the rest of the app —
> there is no server enforcing it, so it should not be relied on as real security if this
> is ever exposed as a multi-user production system with sensitive data.

## Running locally

No install, no build. Either:

- Double-click `index.html` to open it directly in a browser, or
- Serve it with any static file server, e.g.:
  ```bash
  npx serve .
  # or
  python3 -m http.server 8080
  ```

## Deploying to Render

This repo includes a `render.yaml` Blueprint, so the simplest path is:

1. Push this repo to GitHub (see commands below).
2. In the Render Dashboard: **New → Blueprint**, connect this repo, and click **Apply**.
   Render will detect `render.yaml` and deploy it as a Static Site automatically.

Or without a Blueprint:

1. **New → Static Site** in the Render Dashboard, connect this repo.
2. Build Command: leave blank.
3. Publish Directory: `.`
4. Deploy.

Every subsequent `git push` to the connected branch triggers an automatic redeploy.

## Project structure

```
.
├── index.html      # the entire application
├── render.yaml      # Render Blueprint (static site)
├── .gitignore
└── README.md
```
