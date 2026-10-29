'use strict';

// Machine-to-machine endpoints for the sys160 mail relay agent.
//
// The portal's backend runs on Cloud Run and cannot reach the factory's
// internal mail server (192.168.100.5 is a private LAN address). So handover
// emails are rendered and parked in mail_outbox, and the agent — a small
// service on sys160, which IS on that LAN — polls here over HTTPS, delivers
// them, and reports back. All traffic is outbound from the factory, so nothing
// needs to be exposed to the internet.
//
// Deliberately NOT behind requireAuth: the agent is not a logged-in user. It
// authenticates with a shared secret in the X-Agent-Token header, compared in
// constant time. Mounted separately in server.js for exactly that reason.

const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Rows are handed out in small batches; a stuck message can't block the queue
// forever because failures are recorded and retried on the next poll.
const MAX_BATCH = 10;
const MAX_ATTEMPTS = 5;

// A claimed row that is never reported back (the agent was stopped, crashed,
// or a second copy was closed mid-batch) is handed out again once its claim is
// this old. It must comfortably exceed the time one batch can legitimately
// take — up to MAX_BATCH messages, each bounded by the agent's SMTP and HTTP
// timeouts — or a slow but healthy batch could be delivered twice.
const CLAIM_LEASE = '15 minutes';

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  // timingSafeEqual throws on length mismatch, so compare lengths first —
  // length is not the secret here, the value is.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  const expected = process.env.MAIL_AGENT_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'Mail relay is not enabled on this server' });
  }
  if (!tokensMatch(req.get('X-Agent-Token'), expected)) {
    return res.status(401).json({ error: 'Invalid agent token' });
  }
  touchHeartbeat(req);
  next();
});

// Record that the agent got through, so the portal can tell a live relay from
// one that is running somewhere but not reaching us. Throttled to one write a
// minute (the agent polls every 20 s). Never fails the request: if the table is
// missing, delivery still works and only the status report is blank.
function touchHeartbeat(req) {
  pool.query(
    `INSERT INTO mail_agent_status (id, last_seen, agent_version, agent_host)
     VALUES (1, now(), $1, $2)
     ON CONFLICT (id) DO UPDATE
        SET last_seen = now(), agent_version = EXCLUDED.agent_version, agent_host = EXCLUDED.agent_host
      WHERE mail_agent_status.last_seen IS NULL
         OR mail_agent_status.last_seen < now() - interval '60 seconds'`,
    [String(req.get('X-Agent-Version') || 'unknown').slice(0, 40),
     String(req.get('X-Agent-Host') || '').slice(0, 80)]
  ).catch(() => {});
}

// GET /api/mail-agent/pending — claim up to MAX_BATCH messages to deliver.
// Claiming is a single UPDATE ... RETURNING guarded by FOR UPDATE SKIP LOCKED,
// so two agents (or an overlapping poll from a slow one) can never pick up the
// same message twice.
//
// Rows whose claim has outlived CLAIM_LEASE are claimable again; if they have
// already used every attempt they are marked failed instead, so nothing can
// sit in 'sending' forever.
router.get('/pending', async (req, res) => {
  await pool.query(
    `UPDATE mail_outbox
        SET status = 'failed',
            last_error = coalesce(last_error || ' | ', '') || 'claimed but never reported after ' || attempts || ' attempts'
      WHERE status = 'sending' AND attempts >= $1
        AND last_attempt < now() - interval '${CLAIM_LEASE}'`,
    [MAX_ATTEMPTS]
  );
  const { rows } = await pool.query(
    `UPDATE mail_outbox SET status = 'sending', attempts = attempts + 1, last_attempt = now()
      WHERE id IN (
        SELECT id FROM mail_outbox
         WHERE (status = 'pending'
                OR (status = 'sending' AND last_attempt < now() - interval '${CLAIM_LEASE}'))
           AND attempts < $2
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING id, to_addrs, cc_addrs, subject, body_html, body_text,
                pdf_name, pdf_bytes, attempts`,
    [MAX_BATCH, MAX_ATTEMPTS]
  );
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      to: r.to_addrs || [],
      cc: r.cc_addrs || [],
      subject: r.subject,
      html: r.body_html,
      text: r.body_text,
      attempts: r.attempts,
      pdfName: r.pdf_name,
      // Base64 so the payload stays plain JSON.
      pdfBase64: r.pdf_bytes ? Buffer.from(r.pdf_bytes).toString('base64') : null,
    })),
  });
});

// POST /api/mail-agent/result — report delivery outcome.
// { id, ok: true } | { id, ok: false, error: "..." }
// A failure goes back to 'pending' so the next poll retries it, until
// MAX_ATTEMPTS, after which it sticks at 'failed' for a human to look at.
router.post('/result', async (req, res) => {
  const b = req.body || {};
  if (!b.id) return res.status(400).json({ error: 'id is required' });

  if (b.ok) {
    await pool.query(
      `UPDATE mail_outbox SET status='sent', sent_at=now(), last_error=NULL WHERE id=$1`,
      [b.id]
    );
    return res.json({ ok: true });
  }

  const { rows } = await pool.query(
    `UPDATE mail_outbox
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            last_error = $2
      WHERE id = $1
      RETURNING status, attempts`,
    [b.id, String(b.error || 'unknown error').slice(0, 2000), MAX_ATTEMPTS]
  );
  res.json({ ok: true, status: rows[0] ? rows[0].status : 'unknown' });
});

// GET /api/mail-agent/health — lets the agent verify its token and the DB
// connection in one call at startup, before it begins polling.
router.get('/health', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM mail_outbox GROUP BY status`
  );
  const counts = {};
  rows.forEach((r) => { counts[r.status] = r.n; });
  res.json({ ok: true, queue: counts });
});

module.exports = router;
