# Development Handover — sys160 as the primary dev machine

Everything needed to develop, deploy, and release the ONEPWS Production Portal
from sys160. After completing this checklist, no PC holds anything exclusive.

## What lives where (post-cutover, Sept 2026)

| Piece | Location |
|---|---|
| Production database | Supabase project `onepws-dispatch` (ap-south-1), schema `portal`, role `portal_app` |
| Backend + frontend | Cloud Run service `onepws-portal`, GCP project `rivet-onepws`, region `asia-south1` — URL: https://onepws-portal-409434899744.asia-south1.run.app |
| This repo | github.com/lokeshlohar-hub/onepws-production-portal — includes `tablet-app/` (Capacitor Android shell) and `electron/` (desktop wrapper) |
| Tablet update feed | `tablet/latest.json` + APK, served by the backend itself |
| Desktop update feed | still `C:\onepws\updates\` on sys160 (port 8080) — only used if the Electron shell changes again |
| sys160's old on-prem stack | frozen fallback; the live DB there is history as of 2026-09-08 |

## One-time sys160 setup

```powershell
winget install --id Google.CloudSDK --silent --accept-package-agreements --accept-source-agreements
winget install --id PostgreSQL.PostgreSQL.17 --silent --accept-package-agreements --accept-source-agreements
winget install --id EclipseAdoptium.Temurin.21.JDK --silent --accept-package-agreements --accept-source-agreements
```

Then `gcloud auth login` **with lokesh.lohar@onepws.com** (access granted via IAM —
no shared passwords) and `gcloud config set project rivet-onepws`.

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

Frontend (`index.html`) and backend both ship in one deploy. Create
`portal-env.yaml` once (values from `backend/.env`):

```yaml
DATABASE_URL: "<the DATABASE_URL from backend/.env>"
PGSSL: "true"
JWT_SECRET: "<the JWT_SECRET from backend/.env>"
NODE_ENV: "production"
```

Then from the repo root:

```powershell
gcloud run deploy onepws-portal --source . --project rivet-onepws --region asia-south1 --allow-unauthenticated --memory 512Mi --cpu 1 --max-instances 1 --min-instances 0 --cpu-boost --env-vars-file portal-env.yaml --quiet
```

Desktops and tablets pick the change up on next load — no installer, no APK.
Keep `--min-instances 0 --max-instances 1` (that's what keeps the bill ≈ ₹0).

## Releasing a tablet APK update (rare — only when the shell itself changes)

1. Bump `versionCode` (+1) and `versionName` in `tablet-app/android/app/build.gradle`
2. `cd tablet-app && npm install` (first time), then
   `cd android && .\gradlew assembleRelease`
   (needs `JAVA_HOME` → the Temurin 21 JDK and the keystore files in place)
3. Copy `android/app/build/outputs/apk/release/app-release.apk` to
   `tablet/ONEPWS-Portal-Tablet-<version>.apk`, update `tablet/latest.json`
   (`versionCode`, `versionName`, `url`), delete the previous APK there
4. Deploy (previous section). Tablets prompt to update on next app launch.

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
