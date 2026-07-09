# ONEPWS Backend API

Phase 1 backend for the ONEPWS Production Control Portal. Adds real, persistent
storage (PostgreSQL) for the parts of the app that matter most first:

- User accounts & logins
- Projects & BOM
- Stage-wise production tracking & QC decisions (including the automatic
  rework-to-new-BOM-line logic)

Everything else in the portal (Maintenance, Calibration, Tool Inventory,
Documents, Reports, Audit Trail) still runs the way it always has — in the
browser's memory — until those get their own phase.

This has been tested end-to-end against a real PostgreSQL database (login,
create project, submit a stage entry, reject-and-rework a component, confirm
the new BOM line and reject log entry both persist) before being handed over.

> **Note:** the frontend (`index.html` at the repo root) is **not yet wired up**
> to call this API — that's the next step. This phase delivers a working,
> tested backend + database so that connection work has something solid to
> build against.

## Local setup

You'll need [Node.js](https://nodejs.org) (v18+) and a PostgreSQL database —
either installed locally, or you can just point this straight at your Render
Postgres instance from your own machine too (see below), so there's only ever
one database to think about.

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — your Postgres connection string
- `JWT_SECRET` — any long random string (generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

Then:

```bash
npm run migrate   # creates the tables
npm run seed      # adds the same demo users the frontend already ships with, plus one sample project
npm start         # starts the API on http://localhost:4000
```

Check it's alive: `curl http://localhost:4000/api/health`

## Demo accounts (seeded automatically)

Same credentials as the frontend currently uses:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Master Admin |
| `prod.admin` | `prod123` | Admin (Production) |
| `qc.admin` | `qc123` | Admin (Quality) |
| `maint.admin` | `maint123` | Admin (Maintenance) |
| `viewer` | `view123` | Viewer |

## API overview

All routes except `/api/health` and `/api/auth/login` require an
`Authorization: Bearer <token>` header (returned by login).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Log in, get a token |
| GET | `/api/auth/me` | Current user's fresh record |
| GET | `/api/auth/users` | List users (Master Admin only) |
| POST | `/api/auth/users` | Create user (Master Admin only) |
| PUT | `/api/auth/users/:id` | Edit user / permissions (Master Admin only) |
| GET | `/api/projects` | List projects |
| GET | `/api/projects/:id` | Project detail + full BOM |
| POST | `/api/projects` | Create project + BOM lines |
| GET | `/api/bom-lines/:lineId` | Single BOM line with per-stage trace |
| GET | `/api/bom-lines/qc/queue` | Everything currently awaiting QC |
| POST | `/api/bom-lines/:lineId/stage-entry` | Operator submits completed qty |
| POST | `/api/bom-lines/:lineId/qc-decision` | QC approves/rejects — rework automatically spawns a new BOM line |
| GET | `/api/bom-lines/qc/reject-log` | Reject/rework history |

## Deploying to Render

This needs **two** new pieces on Render, in addition to the static site you
already deployed:

### 1. PostgreSQL database

- Render Dashboard → **New** → **PostgreSQL**
- Give it a name (e.g. `onepws-db`), choose the free plan, **Create Database**
- Wait for it to finish provisioning, then open it and copy the **Internal Database URL**

### 2. Web Service (this backend)

- Render Dashboard → **New** → **Web Service**
- Connect the same GitHub repo
- **Root Directory:** `backend`
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- Under **Environment Variables**, add:
  - `DATABASE_URL` → paste the Internal Database URL you copied above
  - `JWT_SECRET` → any long random string
  - `PGSSL` → `false` (Render's internal database URL doesn't need SSL)
- **Create Web Service**

Once it's live, run the migration and seed **once**, from your own machine,
pointed at Render's database using its **External Database URL** (found on the
database's page — the internal one only works from inside Render):

```bash
DATABASE_URL="<external database url from Render>" PGSSL=true npm run migrate
DATABASE_URL="<external database url from Render>" PGSSL=true npm run seed
```

After that, your backend URL (something like `onepws-backend.onrender.com`)
is a live, working API backed by a real, persistent database.
