const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function rowToInstrument(row) {
  return {
    id: row.id,
    tagNo: row.tag_no,
    name: row.name,
    make: row.make,
    range: row.instrument_range,
    leastCount: row.least_count,
    department: row.department,
    owner: row.owner,
    frequencyMonths: row.frequency_months,
    lastCalDate: row.last_cal_date ? row.last_cal_date.toISOString().split('T')[0] : null,
    nextDueDate: row.next_due_date ? row.next_due_date.toISOString().split('T')[0] : null,
    agency: row.agency,
    certNo: row.cert_no,
    status: row.status,
    remarks: row.remarks,
    history: row.history || [],
  };
}

// GET /api/calibration-instruments — full list (any authenticated user)
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM calibration_instruments ORDER BY tag_no');
  res.json({ instruments: rows.map(rowToInstrument) });
});

// POST /api/calibration-instruments — create one instrument
// Body matches the frontend's instrument shape (camelCase)
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const b = req.body || {};
  if (!b.tagNo || !b.name || !b.department || !b.owner) {
    return res.status(400).json({ error: 'tagNo, name, department, and owner are required' });
  }
  const { rows: seqRows } = await pool.query("SELECT nextval('calib_id_seq') AS n");
  const id = 'CAL-' + String(seqRows[0].n).padStart(4, '0');
  const { rows } = await pool.query(
    `INSERT INTO calibration_instruments
      (id, tag_no, name, make, instrument_range, least_count, department, owner,
       frequency_months, last_cal_date, next_due_date, agency, cert_no, status, remarks, history)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [id, b.tagNo, b.name, b.make || null, b.range || null, b.leastCount || null,
     b.department, b.owner, b.frequencyMonths || 12, b.lastCalDate || null, b.nextDueDate || null,
     b.agency || null, b.certNo || null, b.status || 'Active', b.remarks || '',
     JSON.stringify(b.history || [])]
  );
  res.json({ instrument: rowToInstrument(rows[0]) });
});

// POST /api/calibration-instruments/bulk — create many at once (used by CSV
// bulk import so a 37-row file doesn't need 37 separate round trips)
// Body: { instruments: [ {tagNo,name,...}, ... ] }
router.post('/bulk', requireRole('admin', 'superadmin'), async (req, res) => {
  const list = (req.body || {}).instruments;
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'instruments array is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const b of list) {
      if (!b.tagNo || !b.name || !b.department || !b.owner) continue; // already validated client-side; skip anything malformed rather than fail the whole batch
      const { rows: seqRows } = await client.query("SELECT nextval('calib_id_seq') AS n");
      const id = 'CAL-' + String(seqRows[0].n).padStart(4, '0');
      const { rows } = await client.query(
        `INSERT INTO calibration_instruments
          (id, tag_no, name, make, instrument_range, least_count, department, owner,
           frequency_months, last_cal_date, next_due_date, agency, cert_no, status, remarks, history)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [id, b.tagNo, b.name, b.make || null, b.range || null, b.leastCount || null,
         b.department, b.owner, b.frequencyMonths || 12, b.lastCalDate || null, b.nextDueDate || null,
         b.agency || null, b.certNo || null, b.status || 'Active', b.remarks || '',
         JSON.stringify(b.history || [])]
      );
      created.push(rowToInstrument(rows[0]));
    }
    await client.query('COMMIT');
    res.json({ instruments: created });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/calibration-instruments/:id — update an existing instrument.
// Used both for editing an instrument's details AND for logging a completed
// calibration cycle (which updates lastCalDate/nextDueDate and appends to history).
router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM calibration_instruments WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Instrument not found' });
  const existing = rowToInstrument(existingRows[0]);
  const merged = { ...existing, ...b };
  const { rows } = await pool.query(
    `UPDATE calibration_instruments SET
       tag_no=$1, name=$2, make=$3, instrument_range=$4, least_count=$5, department=$6, owner=$7,
       frequency_months=$8, last_cal_date=$9, next_due_date=$10, agency=$11, cert_no=$12,
       status=$13, remarks=$14, history=$15, updated_at=now()
     WHERE id=$16 RETURNING *`,
    [merged.tagNo, merged.name, merged.make, merged.range, merged.leastCount, merged.department, merged.owner,
     merged.frequencyMonths, merged.lastCalDate, merged.nextDueDate, merged.agency, merged.certNo,
     merged.status, merged.remarks, JSON.stringify(merged.history || []), req.params.id]
  );
  res.json({ instrument: rowToInstrument(rows[0]) });
});

// DELETE /api/calibration-instruments/:id
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, tag_no FROM calibration_instruments WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Instrument not found' });
  await pool.query('DELETE FROM calibration_instruments WHERE id = $1', [req.params.id]);
  res.json({ ok: true, deletedId: req.params.id, tagNo: rows[0].tag_no });
});

module.exports = router;
