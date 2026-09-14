# ONEPWS Handover Mail Relay Agent

Sends handover notification emails — HTML table in the body, PDF attached —
through the factory's internal mail server.

## Why this exists

The portal's backend runs on Google Cloud Run. The mail server is
`192.168.100.5`, a private LAN address with **no route from the internet**, and
Google additionally blocks outbound port 25. So the cloud backend cannot send
these emails itself, no matter how it is configured.

Instead the backend renders each notification (HTML body + PDF) and parks it in
the `mail_outbox` table. This agent runs on **sys160**, which is on that LAN. It
polls the portal over HTTPS, delivers each message through the internal mail
server, and reports the result back.

```
 Portal (Cloud Run) ──renders & queues──> mail_outbox (Supabase)
                                               ▲  │
                            HTTPS poll (outbound)  │ claim
                                               │  ▼
                        sys160: mail-agent ────────────┐
                                               │        │ SMTP :25
                                               └──> 192.168.100.5
```

Every connection is **outbound from the factory**. No port forwarding, no VPN,
no firewall change, and nothing exposed to the internet.

## Step 0 — does this machine even need a login?

`production@workspace.com` is a distribution **group**, not a mailbox: it has
no password and cannot be used to log in. It is a perfectly good *recipient*.
What the agent needs is a way to *send*.

Internal mail servers commonly allow unauthenticated relay from trusted IP
ranges, usually their own subnet. sys160 (192.168.100.160) sits on the mail
server's subnet, so it may be permitted where other machines are not. Check
before asking IT to create an account:

```powershell
node mail-agent\probe.js
```

It stops before sending anything — no mail is delivered. It reports either
"CAN send without a login" (leave `SMTP_USER`/`SMTP_PASS` blank) or "requires a
login" (ask IT for a real mailbox account, e.g. `portal@workspace.com`).

## Install on sys160

The repo clone on sys160 lives at
`C:\Users\lokesh.lohar\Documents\GitHub\onepws-production-portal` — adjust the
paths below if it ever moves.

The quickest route is the setup script, which does all of this and verifies the
password before installing anything:

```powershell
powershell -ExecutionPolicy Bypass -File .\mail-agent\setup.ps1 -AgentToken "<token>"
```

To do it by hand instead:

```powershell
cd C:\Users\lokesh.lohar\Documents\GitHub\onepws-production-portal\mail-agent
npm install
copy .env.example .env
notepad .env
```

Fill in `.env`:

| Setting | Value |
|---|---|
| `PORTAL_URL` | `https://onepws-portal-207920932496.asia-south1.run.app` |
| `MAIL_AGENT_TOKEN` | the shared secret (must match the Cloud Run env var exactly) |
| `SMTP_HOST` | `192.168.100.5` |
| `SMTP_PORT` | `25` |
| `SMTP_SECURE` | `false` |
| `SMTP_USER` | `production@workspace.com` |
| `SMTP_PASS` | that mailbox's password |

Test it in the foreground first — it verifies the mail server and the portal
token at startup and exits with a clear message if either fails:

```powershell
npm start
```

Expect:

```
SMTP connection OK
portal OK, queue: {}
```

## Run as a Windows service

Matches the existing NSSM pattern used by `ONEPWSExtractor` and `ONEPWSUpdates`:

```powershell
nssm install ONEPWSMailAgent "C:\Program Files\nodejs\node.exe" "C:\Users\lokesh.lohar\Documents\GitHub\onepws-production-portal\mail-agent\agent.js"
nssm set ONEPWSMailAgent AppDirectory "C:\Users\lokesh.lohar\Documents\GitHub\onepws-production-portal\mail-agent"
nssm set ONEPWSMailAgent AppStdout "C:\onepws\logs\mail-agent-stdout.log"
nssm set ONEPWSMailAgent AppStderr "C:\onepws\logs\mail-agent-stderr.log"
nssm set ONEPWSMailAgent Start SERVICE_AUTO_START
nssm start ONEPWSMailAgent
```

Then confirm the log ends with `SMTP connection OK` / `portal OK` — a service
reporting `SERVICE_RUNNING` does not by itself prove the app did not crash and
get restarted.

## Enabling it on the portal side

The portal only queues mail when `MAIL_AGENT_TOKEN` is set on the Cloud Run
service. Until then it reports "not configured" and the app falls back to the
original mailto: flow, so **start the agent first, then enable the portal** —
otherwise messages would queue with nothing to deliver them.

```powershell
gcloud run services update onepws-portal --project studio-9093266581-e412a --region asia-south1 --update-env-vars MAIL_AGENT_TOKEN=<the same secret>
```

To roll back, remove it again:

```powershell
gcloud run services update onepws-portal --project studio-9093266581-e412a --region asia-south1 --remove-env-vars MAIL_AGENT_TOKEN
```

## Operating notes

- **Delivery delay** is one poll cycle (default 20s). The portal watches for up
  to two minutes and tells the sender when it lands, or warns if it doesn't.
- **Retries**: a failed send returns to `pending` and is retried on the next
  poll, up to 5 attempts, then marked `failed` with the reason in `last_error`.
- **If the agent is stopped**, nothing is lost — messages accumulate in
  `mail_outbox` and flush when it starts again. Senders see a warning that the
  relay may not be running.
- **Nothing blocks the audit trail**: handover_log rows are written by the
  portal independently of whether the email was delivered.

Check the queue at any time:

```sql
SELECT status, count(*) FROM portal.mail_outbox GROUP BY status;
SELECT id, created_at, status, attempts, last_error FROM portal.mail_outbox
 WHERE status <> 'sent' ORDER BY created_at DESC;
```

## Security

- The agent authenticates with a shared token compared in constant time;
  requests without it are rejected.
- SMTP runs unencrypted because the internal server offers no STARTTLS. That is
  acceptable **only** because the connection never leaves the factory LAN. If
  the mail server is ever exposed beyond the LAN, this must be revisited.
- `.env` holds the mailbox password and the agent token and is gitignored.
  Never commit it.
