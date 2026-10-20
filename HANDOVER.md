# Development Handover — sys160 as the primary dev machine

Everything needed to develop, deploy, and release the ONEPWS Production Portal
from sys160. After completing this checklist, no PC holds anything exclusive.

> **Hosting moved on 2026-10-20** to the company Google Cloud project
> `onepws-apps` (organisation pyrotechworkspace.com). Read
> [`MIGRATION-2026-10.md`](MIGRATION-2026-10.md) first — it lists what changed
> and the steps still to do on sys160. Developers no longer have Google Cloud
> access: push to `main`, and the project owner deploys.

## What lives where (since 2026-10-20)

| Piece | Location |
|---|---|
| Production database | Supabase project `onepws-dispatch` (ap-south-1), schema `portal`, role `portal_app` |
| Backend + frontend | Cloud Run service `onepws-portal`, company GCP project `onepws-apps`, region `asia-south1` — URL: https://onepws-portal-261772287521.asia-south1.run.app |
| Old URLs (until ~2026-10-22) | `onepws-portal-207920932496…` and `onepws-portal-w5hz6wgo4q-el…` only **forward** to the new URL; they stop working when the old personal project's trial ends |
| Secrets | Secret Manager in `onepws-apps`: `portal-DATABASE_URL`, `portal-JWT_SECRET`, `portal-MAIL_AGENT_TOKEN` (values unchanged) |
| This repo | github.com/lokeshlohar-hub/onepws-production-portal — includes `tablet-app/` (Capacitor Android shell) and `electron/` (desktop wrapper) |
| Tablet update feed | `tablet/latest.json` + APK, served by the backend itself |
| Desktop update feed | still `C:\onepws\updates\` on sys160 (port 8080) — desktop **1.0.5** (new URL) must be placed there, see MIGRATION-2026-10.md |
| sys160's old on-prem stack | frozen fallback; the live DB there is history as of 2026-09-08 |

## One-time sys160 setup

```powershell
winget install --id Google.CloudSDK --silent --accept-package-agreements --accept-source-agreements
winget install --id PostgreSQL.PostgreSQL.17 --silent --accept-package-agreements --accept-source-agreements
winget install --id EclipseAdoptium.Temurin.21.JDK --silent --accept-package-agreements --accept-source-agreements
```

Google Cloud: **no developer access** since the move to `onepws-apps` (company
policy). `gcloud` is not needed for day-to-day work; deploys are done by the
project owner from `main`.

For APK builds, install Android command-line tools:
download https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip,
extract to `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\`, then:

```powershell
%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat --licenses
%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

## Secrets to receive over an encrypted channel (LocalSend / password manager — NEVER git)

1. `backend/.env` — Supabase connection string (role `portal_app`, transaction
   pooler port 6543), `JWT_SECRET`, `PGSSL=true`. Place at `backend/.env`.
2. `onepws-portal.keystore` + `keystore.properties` — the APK signing key.
   Place at `tablet-app/onepws-portal.keystore` and
   `tablet-app/android/keystore.properties`. **Irreplaceable: every future APK
   must be signed with this key or tablets refuse to update. Keep a second
   copy in a password manager.**
3. The Supabase `postgres` admin password (dashboard + schema-admin work only;
   day-to-day dev never needs it).

## Deploying backend/frontend changes

1. Commit and **push to `main`** — the deployed portal is always built from
   `main`, never from a local working copy (the live image was found to contain
   unpushed code in Sept 2026; that must not happen again).
2. Ask the project owner (Abhijeet) to deploy. The owner runs, from a clean
   checkout of `main`:

```bash
gcloud run deploy onepws-portal --source . --project onepws-apps --region asia-south1 --quiet
```

Secrets and resource settings (512Mi / min-instances 0 / max-instances 1) are
stored on the service and carry over to every revision — a routine deploy
needs no credentials. Desktops and tablets pick the change up on next load.

A push-to-deploy pipeline with owner approval is planned; until then, step 2
is manual.

## Releasing a tablet APK update (rare — only when the shell itself changes)

1. Bump `versionCode` (+1) and `versionName` in `tablet-app/android/app/build.gradle`
2. `cd tablet-app && npm install` (first time), then
   `cd android && .\gradlew assembleRelease`
   (needs `JAVA_HOME` → the Temurin 21 JDK and the keystore files in place)
3. Copy `android/app/build/outputs/apk/release/app-release.apk` to
   `tablet/ONEPWS-Portal-Tablet-<version>.apk`, update `tablet/latest.json`
   (`versionCode`, `versionName`, `url`), delete the previous APK there
4. Push to `main` and ask for a deploy (previous section). Tablets prompt to
   update on next app launch.

## Releasing a desktop (Electron) update (rare)

1. Bump version in `electron/package.json`; `cd electron && npm install && npm run dist`
2. Copy `dist/ONEPWS-Portal-Setup-<v>.exe`, `.blockmap`, and `latest.yml`
   into `C:\onepws\updates\` on sys160
3. Desktops auto-update within 4 hours (File → Check for Updates to force)

## Database admin

Connect with psql using the string in `backend/.env` (or session pooler port
5432 for long operations). All tables are in schema `portal`. Before any
schema/data surgery: `pg_dump` first — dumps restore into a wiped schema in
minutes (see git history of the migration for the exact recipe).
