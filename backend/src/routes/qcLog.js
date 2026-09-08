const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/qc-log/machines -- every distinct machine/stage that has ever
// appeared in QC history, all-time (not date-filtered), so the filter
// dropdown stays complete regardless of the currently selected date range.
// Registered BEFORE the '/' route with a param, since Express matches routes
// in order and '/machines' would otherwise never be reached if a param route
// came first.
router.get('/machines', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT stage FROM qc_log WHERE stage IS NOT NULL AND stage <> '' ORDER BY stage`
  );
  res.json({ machines: rows.map((r) => r.stage) });
});

// GET /api/qc-log -- complete QC history (Pass + Reject + Partial), filtered
// server-side so the frontend never loads the full historical table. Defaults
// to the current month when no date range is given -- older records stay in
// the database and are retrievable on demand via the from/to params.
// Query params (all optional): from, to (YYYY-MM-DD), segment (wood|ext),
// status (Pass|Reject), project (free-text search on SAP/customer/item),
// stage (exact machine/stage name).
router.get('/', async (req, res) => {
  let { from, to, segment, status, project, stage } = req.query;

  if (!from) {
    const now = new Date();
    from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  }
  if (!to) {
    to = new Date().toISOString().split('T')[0];
  }

  const conditions = ['date >= $1', 'date <= $2'];
  const values = [from, to];
  let i = 3;

  if (segment && segment !== 'all') {
    conditions.push(`segment = $${i}`);
    values.push(segment);
    i++;
  }
  if (status === 'Pass') {
    conditions.push('approve_qty > 0');
  } else if (status === 'Reject') {
    conditions.push('reject_qty > 0');
  }
  if (stage && stage !== 'all') {
    conditions.push(`stage = $${i}`);
    values.push(stage);
    i++;
  }
  if (project) {
    conditions.push(`(proj_sap ILIKE $${i} OR customer ILIKE $${i} OR item ILIKE $${i})`);
    values.push(`%${project}%`);
    i++;
  }

  const where = 'WHERE ' + conditions.join(' AND ');
  const { rows } = await pool.query(
    `SELECT * FROM qc_log ${where} ORDER BY ts DESC LIMIT 2000`,
    values
  );
  res.json({ qcLog: rows, from, to });
});

module.exports = router;