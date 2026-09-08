# Answers to Migration-Planning Questions

**Important context for whoever reads this (Claude Code or otherwise):**
These answers come from a *previous* chat-based session with Ankit (non-
technical business owner), not from someone with direct infrastructure
access. Several of these questions are about Ankit's business operations,
accounts, and hardware that the previous session had no visibility into.
Where the honest answer is "I don't know, only Ankit can say," that's
stated plainly rather than guessed at — please treat any gaps below as
open questions still needing Ankit's direct input, not as settled facts.

---

## 1. Where is the real production data — Render backend, on-prem `sys160`, or both?

**Flagging a discrepancy, not answering it.** The previous session's *entire*
body of work (extensive database queries, schema inspection, live bug
fixes, data backfills) was performed against an **on-prem Windows Server**
called `sys160`, static LAN IP `192.168.100.160`, PostgreSQL database
`onepws_prod`, app user `onepws_app`. This is documented in detail in
`ARCHITECTURE.md` and `DATABASE.md`.

**There is no record, anywhere in the prior session, of
`onepws-productionportal.onrender.com` or any Render.com deployment ever
being mentioned, discussed, or worked on.** This could mean:
- It's a separate, newer deployment Ankit set up independently (e.g. for
  remote/tablet access testing) that the previous chat session was never
  told about, or
- It's a stale/abandoned artifact, or
- There's some confusion about which URL/environment is "the real one."

**Action needed:** Ankit needs to directly confirm which one currently
holds the real, current, being-used-in-production data — do not assume
`sys160` is still authoritative just because it's the one this
documentation describes in depth. Whichever one it is, that's the one to
`pg_dump` from for the Supabase migration.

## 2. How much is actually persisted to the backend vs. still in-memory?

**Partial, honest answer based on what was directly verified:**

**Confirmed backend-persisted** (worked with these tables and their live
data extensively): Projects (`projects`), BOM lines and routing
(`bom_lines`), stage-wise production tracking (embedded in `bom_lines
.stage_data`), QC decisions — both the pre-existing rejection log
(`reject_log`) and a newly-added complete pass+reject history (`qc_log`),
TAT overrides (`tat_overrides`), and Handover Notifications
(`handover_log`). These are real, durable, and were manipulated directly
via SQL and confirmed via the running app.

**Not verified either way this session:** Dashboard, Capacity Planning,
Calibration, Maintenance, and Analytics & MIS. The database *does* contain
tables that strongly suggest at least partial backend persistence exists
for some of these — `daily_capacity`, `calibration_instruments`,
`breakdown_log`, `tool_inventory`, `tool_issue_log`, `why_why_log`,
`mistake_register`, `todo_list`, `dms_documents`, `job_work_outward` all
exist as real tables (see `DATABASE.md`'s "not inspected" section) — but
whether every screen in those app sections actually reads/writes to those
tables consistently, or whether some sub-features within them are still
client-side-only arrays that reset on refresh (matching what the README
apparently says), was never checked.

**Recommended next step, not an answer:** Before scoping the tablet app,
grep the relevant frontend render functions for each of those five areas
and check whether they call a backend API or only touch a `DB.xyz`
in-memory array with no corresponding `fetch`/`apiRequest` call. This is
mechanical, fast work for a session with direct file access — it wasn't
done previously only because the prior session's work was scoped to BOM/
QC/production/handover/TAT, never to these five other areas.

## 3. Shop-floor Wi-Fi reliability / offline requirement

**No information available.** This is operational knowledge specific to
Ankit's physical factory floor that no prior session ever discussed.
**Ankit needs to answer this directly** — it materially changes the
architecture (a remote-URL/Cloud-Run-backed tablet app is a fundamentally
different build than one requiring offline-first local storage with sync).

## 4. Tablet scope — whole app or a shop-floor subset?

**Ankit's decision — not something to infer.** One relevant observation
from the work done so far, offered as input to that decision rather than
an answer: **New Project Entry** (BOM data entry, routing setup) is a
data-entry-heavy, keyboard/dropdown-intensive workflow that has
historically been used on desktop-class screens. **Stage-wise Production
Updates, QC approval, and Handover Notification**, by contrast, are the
workflows this session spent the most time on for shop-floor operators —
they're simpler, more checkbox/tap-driven, and a more natural fit for a
tablet's touch interface. If a narrower first release is attractive, that
QC/stage/handover cluster is the most tablet-native subset based on how
those screens actually work today.

## 5. APK distribution method, and who produces signed builds?

**No information available — needs an owner.** Ankit is explicitly
non-technical (confirmed repeatedly across the prior session's entire
working style). Producing a signed Android build requires either a
person/vendor with Android Studio and a Google Play Console developer
account, or a decision to use a build service. **This needs to be
resolved with Ankit directly**: does such a resource already exist
(an IT contractor, a hired developer, an agency), or does this migration
plan need to include acquiring one?

## 6. Does Electron stay in production alongside tablets, or full replacement?

**Ankit's decision.** No prior discussion of retiring the Windows desktop
app exists. Given ~15 concurrent users today, most likely on desktop PCs
in an office/shop-floor mix, a phased approach (tablets added alongside
the existing Electron app, not replacing it immediately) is a common
pattern — but this is a suggestion for Ankit to react to, not a settled
answer.

## 7. GCP / Supabase account status

**Partial answer, from Ankit's own words in this conversation:**
Supabase — Ankit stated an account **"will be created"**, implying it does
not exist yet. Google Cloud Run — Ankit said **"I will be providing the
credentials,"** which is ambiguous as to whether an existing GCP project/
billing account already exists (and he'll share access to it) or whether
one still needs to be created. **Ankit should confirm explicitly** which
of the two it is before planning deployment steps.

## 8. SMTP/email migration — fold into this migration or handle separately?

**This one has a real, concrete status from direct work in this
session — not a guess:**

Ankit and the prior session had already agreed to move the Handover
Notification feature off `mailto:` (which cannot render HTML tables or
carry attachments — a hard protocol limitation, not a bug) onto real
SMTP-based sending, because Ankit wants the received email to look like
the formatted table shown in the app's own popup.

**Confirmed so far:**
- Sending account: `production@workspace.com`
- Password provided: `production` (**flagging directly: this is a weak
  password for an account about to send automated mail — strongly
  recommend changing it before wiring up real SMTP sending with it**)
- Plan: use `nodemailer` on the backend, build a table-based HTML email
  template compatible with Outlook's Word-based rendering engine, and
  switch the existing "Send Handover Notification" button from opening a
  `mailto:` link to an actual backend-dispatched send — while keeping
  recipient selection, CC, the review-before-send step, and audit logging
  exactly as they already work.

**Not yet obtained:** the actual SMTP server address, port, and SSL
setting. Ankit was in the process of looking these up in Windows Live
Mail's account settings for `production@workspace.com` when this
migration conversation began. **This is a small, well-defined, mostly-
finished task** — recommend just finishing it (get those three values from
Ankit, build the sender) rather than bundling it into the larger
Supabase/Cloud Run/tablet migration, since it's independent of all three
and could ship first.

## 9. Tablet hardware — Android version, screen size, unit count

**No information available.** Pure procurement/hardware knowledge specific
to Ankit's plans that no prior session ever discussed. **Ankit needs to
answer this directly** — it affects minimum Android SDK target, UI density/
layout decisions, and Capacitor vs. native tooling choices.

---

## Summary: what's actually settled vs. what needs Ankit

| # | Question | Status |
|---|---|---|
| 1 | Data location (Render vs sys160) | **Unresolved — real discrepancy, needs Ankit** |
| 2 | Persistence scope | Partially known; 5 areas need direct code verification |
| 3 | Wi-Fi / offline | **Needs Ankit** |
| 4 | Tablet scope | **Needs Ankit** (suggestion offered above) |
| 5 | APK distribution / build owner | **Needs Ankit** |
| 6 | Electron stays or replaced | **Needs Ankit** |
| 7 | GCP/Supabase account status | Partially known from Ankit's own wording; needs explicit confirmation |
| 8 | SMTP scope | **Known and mostly done** — just needs 3 server values from Ankit |
| 9 | Tablet hardware | **Needs Ankit** |
