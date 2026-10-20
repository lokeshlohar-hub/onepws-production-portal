# ONEPWS Production Portal — notes for Claude Code

## Read first, every session
1. `MIGRATION-2026-10.md` — hosting moved to the company Google Cloud project
   `onepws-apps` on 2026-10-20; lists the sys160 steps still open.
2. The handoff docs at the repo root: `HANDOVER.md`, `APP_OVERVIEW.md`,
   `ARCHITECTURE.md`, `DATABASE.md`, `CODE_PATTERNS_AND_GOTCHAS.md`
   (and `MIGRATION_QUESTIONS_STATUS.md` for history).

## Facts
- Live portal: https://onepws-portal-261772287521.asia-south1.run.app
  (Cloud Run `onepws-portal`, project `onepws-apps`, `asia-south1`).
  The two older URLs only forward there and disappear ~2026-10-22 — never put
  them in new code or docs.
- Database: Supabase `onepws-dispatch`, schema `portal`, role `portal_app`.
- Frontend = root `index.html` (+ `dialog-helpers.js`, `csv-import.js`), served
  by the Express backend in `backend/`; PDF extractor sidecar in `extractor/`.
- Shells: `tablet-app/` (Capacitor Android, update feed `tablet/latest.json`
  served by the backend) and `electron/` (desktop, update feed
  `C:\onepws\updates\` on sys160, port 8080).
- Mail: the portal queues mail in `portal.mail_outbox`; `mail-agent/` on sys160
  delivers it through the office SMTP relay (192.168.100.5). See
  `mail-agent/README.md`.

## Rules
- **No Google Cloud access for developers.** Do not run or suggest
  `gcloud run deploy`, IAM, or Secret Manager commands for this project. To
  ship: commit, push to `main`, and ask the owner (Abhijeet) to deploy.
- **The live portal must always equal `main`.** Never deploy, or ask for a
  deploy of, anything that is not pushed.
- **Never commit secrets:** `backend/.env`, `mail-agent/.env`, the keystore
  (`onepws-portal.keystore`) and `tablet-app/android/keystore.properties` stay
  out of git (see `.gitignore`). Do not print their contents.
- **Tablet APK releases** must be signed with the existing portal keystore and
  bump `versionCode` — tablets refuse an APK signed with any other key.
- Keep changes small and visible; the live app is used on the shop floor.
