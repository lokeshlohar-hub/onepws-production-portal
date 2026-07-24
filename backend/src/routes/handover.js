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
    triggeredBy: row.triggered_by,
    details: row.details || {},
  };
}

// GET /api/handover-log — full history, most recent first
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM handover_log ORDER BY ts DESC');
  res.json({ handoverLog: rows.map(rowToHandover) });
});

// POST /api/handover-log — record a triggered handover notification.
// This app has no outbound SMTP/email service configured, so this endpoint
// records the notification (for the audit trail) rather than actually
// sending an email itself — the frontend opens the user's own mail client
// with the message pre-filled via a mailto: link, so a human reviews and
// sends it, and this call is what makes that event permanently traceable.
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.lineId || !b.projectId || !b.email) {
    return res.status(400).json({ error: 'lineId, projectId, and email are required' });
  }
  const id = 'HO-' + String(Date.now()).slice(-8);
  const { rows } = await pool.query(
    `INSERT INTO handover_log
      (id, line_id, project_id, proj_sap, item, qty, uom, segment, final_stage, department, email, triggered_by, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id, b.lineId, b.projectId, b.proj || '', b.item || '', b.qty || 0, b.uom || '',
     b.segment || '', b.finalStage || '', b.department || '', b.email,
     b.triggeredBy || 'Unknown', JSON.stringify(b.details || {})]
  );
  res.json({ handover: rowToHandover(rows[0]) });
});

module.exports = router;
