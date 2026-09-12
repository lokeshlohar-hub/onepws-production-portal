const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { isMailConfigured, sendHandoverMail, verifyConnection, mailConfigSummary } = require('../lib/mailer');
const { buildEmailHtml, buildEmailText, buildPdfBuffer, pdfFileName } = require('../lib/handoverDoc');

const router = express.Router();
router.use(requireAuth);

function rowToHandover(row) {
  return {
    id: row.id,
    ts: row.ts,
    lineId: row.line_id,
    projectId: row.project_id,
    proj: row.proj_sap,
    item: row.item,
    qty: row.qty,
    uom: row.uom,
    segment: row.segment,
    finalStage: row.final_stage,
    department: row.department,
    email: row.email,
    ccEmails: row.cc_emails || [],
    triggeredBy: row.triggered_by,
    details: row.details || {},
  };
}

// GET /api/handover-log — full history, most recent first
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM handover_log ORDER BY ts DESC');
  res.json({ handoverLog: rows.map(rowToHandover) });
});

// GET /api/handover-log/address-history — every distinct address ever used
// on a Handover Notification, whether as the primary To recipient (email
// column) or as one of the Cc recipients (cc_emails JSONB), returned with
// its total use-count and last-used timestamp so the frontend can order the
// picker with the most-recently-and-most-frequently-used addresses first.
// This is what drives the "history-driven" address list in the notification
// modal — admin-configured recipients from admin_config.handoverRecipients
// are merged in on top by the frontend so the picker shows both sources in
// one deduplicated checkbox list.
router.get('/address-history', async (req, res) => {
  const { rows } = await pool.query(`
    WITH all_addrs AS (
      SELECT email AS addr, ts FROM handover_log
        WHERE email IS NOT NULL AND email <> ''
      UNION ALL
      SELECT jsonb_array_elements_text(cc_emails) AS addr, ts FROM handover_log
    )
    SELECT addr AS email, COUNT(*)::int AS use_count, MAX(ts) AS last_used
    FROM all_addrs
    WHERE addr IS NOT NULL AND addr <> ''
    GROUP BY addr
    ORDER BY use_count DESC, last_used DESC
  `);
  res.json({
    addresses: rows.map((r) => ({
      email: r.email,
      useCount: r.use_count,
      lastUsed: r.last_used,
    })),
  });
});

// POST /api/handover-log — record a triggered handover notification.
// This app has no outbound SMTP/email service configured, so this endpoint
// records the notification (for the audit trail) rather than actually
// sending an email itself — the frontend opens the user's own mail client
// with the message pre-filled via a mailto: link, so a human reviews and
// sends it, and this call is what makes that event permanently traceable.
// Accepts an optional ccEmails array so the full recipient set (To + Cc) is
// preserved in history.
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.lineId || !b.projectId || !b.email) {
    return res.status(400).json({ error: 'lineId, projectId, and email are required' });
  }
  const ccEmails = Array.isArray(b.ccEmails)
    ? b.ccEmails.filter((e) => e && typeof e === 'string')
    : [];
  const id = 'HO-' + String(Date.now()).slice(-8);
  const { rows } = await pool.query(
    `INSERT INTO handover_log
      (id, line_id, project_id, proj_sap, item, qty, uom, segment, final_stage,
       department, email, cc_emails, triggered_by, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [id, b.lineId, b.projectId, b.proj || '', b.item || '', b.qty || 0, b.uom || '',
     b.segment || '', b.finalStage || '', b.department || '', b.email,
     JSON.stringify(ccEmails),
     b.triggeredBy || 'Unknown', JSON.stringify(b.details || {})]
  );
  res.json({ handover: rowToHandover(rows[0]) });
});

// GET /api/handover-log/mail-status — is server-side sending available?
// The frontend calls this when the handover modal opens so it can show the
// real "Send Email" button when SMTP is live, and keep the existing mailto: +
// printable-document flow when it isn't. `verify` runs a real connection/login
// check (used by the admin diagnostic, not on every modal open).
router.get('/mail-status', async (req, res) => {
  const summary = mailConfigSummary();
  const relay = Boolean(process.env.MAIL_AGENT_TOKEN);
  // `canSend` is the single flag the frontend acts on: true when either
  // transport is available (direct SMTP, or the sys160 relay).
  const base = Object.assign({}, summary, {
    relayEnabled: relay,
    mode: summary.configured ? 'direct' : (relay ? 'relay' : 'none'),
    canSend: summary.configured || relay,
  });

  // In relay mode the useful health signal isn't an SMTP handshake (this
  // server can't reach the mail host at all) but whether the agent is actually
  // draining the queue — a stalled agent is the realistic failure here.
  if (relay && !summary.configured) {
    try {
      const { rows } = await pool.query(
        `SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
                count(*) FILTER (WHERE status='failed')::int  AS failed,
                max(sent_at) AS last_sent
           FROM mail_outbox`
      );
      base.queue = { pending: rows[0].pending, failed: rows[0].failed, lastSent: rows[0].last_sent };
    } catch (_) { /* table may not exist yet on an older DB — not fatal */ }
    return res.json(base);
  }

  if (!summary.configured || String(req.query.verify) !== 'true') {
    return res.json(base);
  }
  try {
    await verifyConnection();
    res.json(Object.assign(base, { verified: true }));
  } catch (err) {
    res.json(Object.assign(base, { verified: false, error: err.message }));
  }
});

// POST /api/handover-log/send — send the notification as a real email:
// an Outlook-safe HTML table in the body plus the same content attached as a
// PDF. Returns 503 (not 500) when SMTP isn't configured so the frontend can
// tell "not set up yet" apart from "tried and failed" and fall back cleanly.
//
// This only sends. Audit rows are still written by POST / (one per component),
// exactly as before — keeping the two concerns separate means a mail outage
// can never cost us the audit trail.
router.post('/send', async (req, res) => {
  const b = req.body || {};
  const to = Array.isArray(b.to) ? b.to.filter((e) => e && typeof e === 'string') : [];
  const cc = Array.isArray(b.cc) ? b.cc.filter((e) => e && typeof e === 'string') : [];

  if (!to.length) return res.status(400).json({ error: 'At least one To address is required' });
  if (!b.pdfData || !Array.isArray(b.pdfData.components) || !b.pdfData.components.length) {
    return res.status(400).json({ error: 'pdfData with at least one component is required' });
  }
  const relayEnabled = Boolean(process.env.MAIL_AGENT_TOKEN);
  if (!isMailConfigured() && !relayEnabled) {
    return res.status(503).json({
      error: 'Email sending is not configured on the server',
      configured: false,
    });
  }

  const subject = (b.subject || '').trim()
    || `Handover Notification — ${b.pdfData.sap || 'Production'}`;

  let pdf;
  let html;
  let text;
  try {
    pdf = await buildPdfBuffer(b.pdfData);
    html = buildEmailHtml(b.pdfData);
    text = buildEmailText(b.pdfData);
  } catch (err) {
    return res.status(500).json({ error: 'Could not build the notification document: ' + err.message, sent: false });
  }

  // Direct send — only possible when the mail server is reachable from
  // wherever this backend runs (e.g. a cloud-reachable provider on 587/TLS).
  // The factory's own server is a private LAN address, so in production this
  // branch is skipped in favour of the relay below.
  if (isMailConfigured()) {
    try {
      const result = await sendHandoverMail({
        to, cc, subject, html, text,
        attachments: [{ filename: pdfFileName(b.pdfData), content: pdf, contentType: 'application/pdf' }],
      });
      return res.json({ sent: true, queued: false, messageId: result.messageId, accepted: result.accepted, rejected: result.rejected });
    } catch (err) {
      // Surface the real reason — bad credentials, blocked port and
      // unreachable host all look identical from the UI otherwise.
      return res.status(502).json({ error: 'Could not send the email: ' + err.message, sent: false });
    }
  }

  // Relay path: park the fully-rendered message for the sys160 agent.
  try {
    const id = 'MO-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    await pool.query(
      `INSERT INTO mail_outbox
         (id, to_addrs, cc_addrs, subject, body_html, body_text, pdf_name, pdf_bytes,
          project_id, proj_sap, queued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, JSON.stringify(to), JSON.stringify(cc), subject, html, text,
       pdfFileName(b.pdfData), pdf,
       b.projectId || null, (b.pdfData && b.pdfData.sap) || null,
       b.triggeredBy || (req.user && (req.user.fullName || req.user.username)) || 'Unknown']
    );
    res.json({ sent: false, queued: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Could not queue the email: ' + err.message, sent: false });
  }
});

// GET /api/handover-log/outbox-status/:id — has the relay delivered it yet?
// The frontend polls this briefly after queueing so the sender gets a real
// confirmation rather than a hopeful "queued" and nothing more.
router.get('/outbox-status/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT status, attempts, last_error, sent_at FROM mail_outbox WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Unknown message id' });
  res.json({
    status: rows[0].status,
    attempts: rows[0].attempts,
    error: rows[0].last_error,
    sentAt: rows[0].sent_at,
  });
});

// POST /api/handover-log/preview-pdf — returns just the PDF, no email sent.
// Lets the sender check the attachment before committing, and gives us a way
// to validate PDF generation without SMTP configured.
router.post('/preview-pdf', async (req, res) => {
  const b = req.body || {};
  if (!b.pdfData || !Array.isArray(b.pdfData.components)) {
    return res.status(400).json({ error: 'pdfData with a components array is required' });
  }
  try {
    const pdf = await buildPdfBuffer(b.pdfData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdfFileName(b.pdfData)}"`);
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate the PDF: ' + err.message });
  }
});

module.exports = router;
