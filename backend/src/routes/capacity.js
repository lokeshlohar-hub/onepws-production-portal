const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function rowToEntry(row) {
  return {
    date: row.cap_date.toISOString().split('T')[0],
    workstationId: row.workstation_id,
    achievedQty: row.achieved_qty,
    helperCount: row.helper_count,
    sourceLog: row.source_log || [],
  };
}

// GET /api/daily-capacity — every recorded (date, workstation) entry.
// The frontend reshapes this into its DB.dailyCap[date][wsId] /
// DB.dailyManpower[date]['hp_'+wsId] structure.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM daily_capacity ORDER BY cap_date');
  res.json({ entries: rows.map(rowToEntry) });
});

// POST /api/daily-capacity/bulk-save — manual Daily Capacity Entry sets the
// achieved qty / helper count directly for a batch of workstations on one date.
// Body: { date, entries: [{workstationId, achievedQty, helperCount}, ...] }
router.post('/bulk-save', requireRole('admin', 'superadmin'), async (req, res) => {
  const { date, entries } = req.body || {};
  if (!date || !Array.isArray(entries)) return res.status(400).json({ error: 'date and entries[] are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const e of entries) {
      const { rows } = await client.query(
        `INSERT INTO daily_capacity (cap_date, workstation_id, achieved_qty, helper_count)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (cap_date, workstation_id)
         DO UPDATE SET achieved_qty=$3, helper_count=$4, updated_at=now()
         RETURNING *`,
        [date, e.workstationId, e.achievedQty || 0, e.helperCount || 0]
      );
      saved.push(rowToEntry(rows[0]));
    }
    await client.query('COMMIT');
    res.json({ entries: saved });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not save daily capacity', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /api/daily-capacity/increment — automatic update from a stage-entry
// completion. Adds to whatever is already recorded for that date+workstation
// rather than overwriting it, since multiple stage completions can land on
// the same workstation the same day. Body: { date, workstationId, addQty, sourceEntry }
router.post('/increment', requireRole('admin', 'superadmin'), async (req, res) => {
  const { date, workstationId, addQty, sourceEntry } = req.body || {};
  if (!date || !workstationId || addQty == null) return res.status(400).json({ error: 'date, workstationId, and addQty are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      'SELECT * FROM daily_capacity WHERE cap_date=$1 AND workstation_id=$2 FOR UPDATE',
      [date, workstationId]
    );
    const newSourceLog = existingRows[0] ? (existingRows[0].source_log || []) : [];
    if (sourceEntry) newSourceLog.push(sourceEntry);
    const { rows } = await client.query(
      `INSERT INTO daily_capacity (cap_date, workstation_id, achieved_qty, helper_count, source_log)
       VALUES ($1,$2,$3,0,$4)
       ON CONFLICT (cap_date, workstation_id)
       DO UPDATE SET achieved_qty = daily_capacity.achieved_qty + $3, source_log=$4, updated_at=now()
       RETURNING *`,
      [date, workstationId, addQty, JSON.stringify(newSourceLog)]
    );
    await client.query('COMMIT');
    res.json({ entry: rowToEntry(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not update capacity', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
