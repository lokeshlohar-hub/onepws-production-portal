const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

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

module.exports = router;
