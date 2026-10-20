# Move to the company Google Cloud project — 2026-10-20

The portal was hosted in a personal Google Cloud project whose free trial ends
around **2026-10-22**. It now runs in the company project **`onepws-apps`**
(organisation pyrotechworkspace.com), together with ECHO, TBMS and Scout.

Nothing about the app itself changed: the running code is exactly `main` at
`caa9710` (verified file-by-file against the live image), same database
(Supabase `onepws-dispatch`, schema `portal`), same secrets, same settings.

## Addresses

| | URL |
|---|---|
| **Portal (new, permanent)** | https://onepws-portal-261772287521.asia-south1.run.app |
| Old Cloud Run URL (desktop 1.0.4, tablets ≤ 1.3, mail agent) | https://onepws-portal-207920932496.asia-south1.run.app — **forwards** to the new URL |
| Oldest URL (office browser bookmarks) | https://onepws-portal-w5hz6wgo4q-el.a.run.app — **forwards** to the new URL |

The two old URLs are small pass-through proxies so nothing broke on the day of
the move. **They stop working when the old project's trial ends (~2026-10-22).**
Everything must be on the new URL before then.

## What this commit changes

| Path | Change |
|---|---|
| `tablet-app/` | Portal URL → new; version **1.4** (versionCode 5) |
| `tablet/ONEPWS-Portal-Tablet-1.4.apk` | Built from this commit, signed with the existing portal keystore (same certificate as 1.3, SHA-256 `dafb26a9…ef26b`), so it installs as an update. 1.2 removed. |
| `tablet/latest.json` | Offers 1.4 from the new URL. Already live: tablets on 1.3 are offered 1.4 on their next launch (through the forwarding old URL). |
| `electron/` | Portal URL → new; version **1.0.5**; `cloudbuild-win.yaml` (optional cloud build of the installer) |
| `mail-agent/` | `.env.example`, `setup.ps1`, README → new URL; token now lives in Secret Manager |
| `HANDOVER.md` | Hosting table + deploy procedure for `onepws-apps` |

## To do on sys160 — before 2026-10-22

1. **Pull:** `git pull` in `C:\Users\lokesh.lohar\Documents\GitHub\onepws-production-portal`.
2. **Mail agent → new URL.** Edit `mail-agent\.env` and set
   `PORTAL_URL=https://onepws-portal-261772287521.asia-south1.run.app`
   (leave `MAIL_AGENT_TOKEN` and the SMTP settings as they are), then restart
   the service: `nssm restart ONEPWSMailAgent`. Check the log ends with
   `SMTP connection OK` / `portal OK`.
3. **Desktop 1.0.5 → update feed.** Either build it (`cd electron`,
   `npm install`, `npm run dist`) or use the verified build from Abhijeet
   (`ONEPWS-Portal-Setup-1.0.5.exe` + `.blockmap` + `latest.yml`, sha512 in
   `latest.yml`). Copy the three files into `C:\onepws\updates\` next to 1.0.4.
   Desktops update within 4 hours (File → Check for Updates to force).
4. **Tablets:** nothing to do on sys160 — just make sure every tablet opens the
   Portal app once before 2026-10-22 and taps **Update**.
5. **Bookmarks:** office browsers using the old URLs should switch to the new
   URL.

## How deploys work now

Developers have **no Google Cloud access** (company policy). Push to `main`;
the project owner deploys from `main` (see HANDOVER.md). The deployed portal is
therefore always exactly what is in git. A push-to-deploy pipeline with owner
approval is planned.
