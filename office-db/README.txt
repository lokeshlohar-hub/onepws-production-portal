ONEPWS PRODUCTION PORTAL - DATABASE ON THE OFFICE SERVER
=========================================================

What changes
  - The portal keeps running on Google Cloud exactly as now (same address, tablets and desktop app untouched).
  - Its database moves from Supabase to the office server's own PostgreSQL (the OnePWS Dispatch server), into a
    separate database "onepws_portal" with its own login "portal_app" - the Dispatch data is not touched.
  - Google Cloud reaches it through a Cloudflare Tunnel: the office server opens an encrypted connection OUT to
    Cloudflare; nothing is opened on the office router or firewall. Only the portal (holding a Cloudflare service
    token) can use it, and PostgreSQL still asks for the portal_app password.
  - From then on the portal needs the office server and the office internet to be up (put the server and router on a UPS).

Before you start
  - onepws.in must be active on Cloudflare (nameservers moved, status "Active").
  - The office server is the OnePWS Dispatch server at 192.168.114.39, with PostgreSQL 17. Run every script
    in this folder ON THAT PC (not on sys160 - sys160 keeps only its mail agent, which is not touched).
  - You need: the "postgres" password of that PostgreSQL; the Supabase connection string of portal_app (SESSION
    pooler, port 5432 - it is the portal's current DATABASE_URL with port 6543 changed to 5432).
  - Copy this whole "office-db" folder to the office server (any folder; Setup copies it to C:\OnePWS\Portal).


STEP 1 - Office server: create the database and copy the data   (about 5 minutes)
  Right-click Setup-Portal-Database.bat > Run as administrator.
    - asks for the "postgres" password, then the Supabase connection string (hidden prompts: copy the value,
      press Enter on the empty prompt)
    - creates database onepws_portal + login portal_app (its own generated password)
    - copies the portal data from Supabase (Supabase is only READ) and compares every table's row count
    - sets up a nightly backup of the portal database at 01:45 (C:\OnePWS\Portal\backups, 30 days)
    - writes C:\OnePWS\Portal\cloud-run-DATABASE_URL.txt = the database address Google Cloud will use (step 4).
      Keep it private: do not e-mail it or paste it in chat.


STEP 2 - Cloudflare dashboard: tunnel, address and access   (about 10 minutes)
  Zero Trust (one.dash.cloudflare.com), with the account that holds onepws.in:
  a) Networks > Tunnels > Create a tunnel > Cloudflared. Name: onepws-portal-db. Environment: Windows.
     Copy the token = the long value after "service install" in the command shown. Do NOT run that command;
     step 3 installs it.
  b) In that tunnel > Public hostname > Add a public hostname  (newer dashboards call it "Published application routes"):
       Subdomain: portal-db    Domain: onepws.in    Type: TCP    URL: localhost:5432
  c) Access > Service Auth > Service Tokens > Create service token. Name: onepws-portal-cloudrun.
     Duration: Non-expiring. Copy the Client ID and the Client Secret (the secret is shown only once).
  d) Access > Applications > Add an application > Self-hosted.
       Name: Portal database    Domain: portal-db.onepws.in
       Policy: Action = Service Auth, Include = Service Token = onepws-portal-cloudrun.   No other policy.
     (Without this application anyone could open the address; with it only the portal's service token can.)


STEP 3 - Office server: install the tunnel   (2 minutes)
  Right-click Install-Portal-Tunnel.bat > Run as administrator, give it the token from step 2a.
  It downloads cloudflared 2026.11.2 (checked against Cloudflare's published checksum) and installs it as the
  Windows service "Cloudflared". The tunnel then shows HEALTHY in the Cloudflare dashboard.


STEP 4 - Google Cloud (you, as owner): secrets and a TEST version with no users on it
  a) Push the code that contains this folder to main (live portal must equal main).
  b) Secret Manager (console, project onepws-apps) > Create secret, three times:
       portal-office-database-url      = contents of C:\OnePWS\Portal\cloud-run-DATABASE_URL.txt
       portal-cf-access-client-id      = Client ID from step 2c
       portal-cf-access-client-secret  = Client Secret from step 2c
     Give the portal's service account access to them (Cloud Shell or your terminal):
       for s in portal-office-database-url portal-cf-access-client-id portal-cf-access-client-secret; do
         gcloud secrets add-iam-policy-binding $s --project onepws-apps \
           --member=serviceAccount:261772287521-compute@developer.gserviceaccount.com \
           --role=roles/secretmanager.secretAccessor
       done
     (If the service uses its own service account, use that one: gcloud run services describe onepws-portal
      --project onepws-apps --region asia-south1 --format="value(spec.template.spec.serviceAccountName)")
  c) Deploy a TEST version that gets NO traffic, from the repo folder:
       gcloud run deploy onepws-portal --source . --project onepws-apps --region asia-south1 \
         --no-traffic --tag officedb \
         --update-env-vars PORTAL_DB_TUNNEL_HOST=portal-db.onepws.in \
         --update-secrets OFFICE_DATABASE_URL=portal-office-database-url:latest,CF_ACCESS_CLIENT_ID=portal-cf-access-client-id:latest,CF_ACCESS_CLIENT_SECRET=portal-cf-access-client-secret:latest
     The live portal keeps using Supabase (its DATABASE_URL is left exactly as it is).
  d) Check the test version:
       https://officedb---onepws-portal-261772287521.asia-south1.run.app/api/health/db   -> "database":"office"
       https://onepws-portal-261772287521.asia-south1.run.app/api/health/db             -> "database":"cloud"
     "ms" is one database round trip - compare the two. Then open the test address, sign in and look around.
     LOOK ONLY - do not change data there: the test copy is replaced by the final sync in step 5.
  IMPORTANT: from step 4c on, ANY other deploy of the portal would go live on the office database. Do the switch
  (step 5) the same day, or undo the test settings first:
       gcloud run services update onepws-portal --project onepws-apps --region asia-south1 --no-traffic \
         --remove-env-vars PORTAL_DB_TUNNEL_HOST


STEP 5 - The switch   (about 10 minutes, at a quiet time - e.g. after the shift)
  1. Ask everyone to stop entering data in the portal for 10 minutes.
  2. Office server: right-click Refresh-Portal-Database.bat > Run as administrator  (final copy from Supabase;
     the earlier office copy is backed up first). Every table must say "same".
  3. Send all users to the tested version:
       gcloud run services update-traffic onepws-portal --project onepws-apps --region asia-south1 --to-tags officedb=100
  4. Check https://onepws-portal-261772287521.asia-south1.run.app/api/health/db says "database":"office",
     sign in, open a project, make one small real change and refresh - it must stay.
  Tablets, the desktop app and the sys160 mail agent keep working unchanged (same portal address).

  Going back (first hours only):
       gcloud run services update-traffic onepws-portal --project onepws-apps --region asia-south1 --to-revisions PREVIOUS_REVISION=100
     (PREVIOUS_REVISION = the one that had 100% before step 3; see Cloud Run > Revisions.) Changes made after the
     switch exist only in the office database - they would have to be copied back to Supabase.


STEP 6 - Afterwards
  - Supabase stays untouched for two weeks as a fallback; then its "portal" schema can be removed.
  - Backups: C:\OnePWS\Portal\backups (nightly 01:45, 30 days). Backup-Portal-Now.bat takes one now.
    Copy that folder to a NAS too - a backup on the same disk does not survive a dead disk.
  - If the portal says the database is unreachable: is the office server on, is the service "Cloudflared"
    running, does the tunnel show HEALTHY in Cloudflare?

Files in this folder
  Setup-Portal-Database.bat / .ps1   step 1 (first copy)        Refresh-Portal-Database.bat   step 5 (final sync)
  Install-Portal-Tunnel.bat / .ps1   step 3                     Backup-Portal-Now.bat          backup now
  portal-backup.ps1                  nightly backup             portal-common.ps1              shared helpers
