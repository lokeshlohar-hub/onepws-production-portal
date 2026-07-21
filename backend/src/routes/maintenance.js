const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function rowToBreakdown(row) {
  return {
    id: row.id,
    segment: row.segment,
    machineId: row.machine_id,
    machineName: row.machine_name,
    breakdownDate: row.breakdown_date ? row.breakdown_date.toISOString().split('T')[0] : null,
    startTime: row.start_time,
    problem: row.problem,
    category: row.category,
    priority: row.priority,
    technicianId: row.technician_id,
    technicianName: row.technician_name,
    repairStart: row.repair_start,
    repairEnd: row.repair_end,
    sparePartsUsed: row.spare_parts_used,
    correctiveAction: row.corrective_action,
    restorationConfirmed: row.restoration_confirmed,
    statusAfterRepair: row.status_after_repair,
    downtimeHours: row.downtime_hours == null ? 0 : Number(row.downtime_hours),
    whyWhyId: row.why_why_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
function rowToWhyWhy(row) {
  return {
    id: row.id,
    breakdownId: row.breakdown_id,
    segment: row.segment,
    machineName: row.machine_name,
    breakdownDate: row.breakdown_date ? row.breakdown_date.toISOString().split('T')[0] : null,
    downtimeHours: row.downtime_hours == null ? 0 : Number(row.downtime_hours),
    why1: row.why1, why2: row.why2, why3: row.why3, why4: row.why4, why5: row.why5,
    rootCause: row.root_cause,
    immediateAction: row.immediate_action,
    preventiveAction: row.preventive_action,
    responsiblePerson: row.responsible_person,
    targetDate: row.target_date ? row.target_date.toISOString().split('T')[0] : null,
    closureRemarks: row.closure_remarks,
    status: row.status,
    closedAt: row.closed_at,
    createdAt: row.created_at,
  };
}

// GET /api/breakdown-log — full breakdown log + full why-why log together,
// since the frontend keeps them as two related in-memory arrays
router.get('/', async (req, res) => {
  const bd = await pool.query('SELECT * FROM breakdown_log ORDER BY breakdown_date DESC, created_at DESC');
  const ww = await pool.query('SELECT * FROM why_why_log ORDER BY created_at DESC');
  res.json({ breakdownLog: bd.rows.map(rowToBreakdown), whyWhyLog: ww.rows.map(rowToWhyWhy) });
});

// POST /api/breakdown-log — create one breakdown entry, optionally with its
// linked Why-Why RCA record in the same request (mirrors saveBreakdownEntry(),
// which creates both together when downtime exceeds the RCA trigger threshold).
// Body: { breakdown: {...}, whyWhy: {...} | null }
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const { breakdown: b, whyWhy: w } = req.body || {};
  if (!b || !b.id || !b.machineName) return res.status(400).json({ error: 'breakdown.id and breakdown.machineName are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO breakdown_log
        (id, segment, machine_id, machine_name, breakdown_date, start_time, problem, category, priority,
         technician_id, technician_name, repair_start, repair_end, spare_parts_used, corrective_action,
         restoration_confirmed, status_after_repair, downtime_hours, why_why_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [b.id, b.segment, b.machineId, b.machineName, b.breakdownDate || null, b.startTime, b.problem, b.category, b.priority,
       b.technicianId, b.technicianName, b.repairStart || null, b.repairEnd || null, b.sparePartsUsed || '', b.correctiveAction || '',
       !!b.restorationConfirmed, b.statusAfterRepair, b.downtimeHours || 0, w ? w.id : null, b.createdBy || 'Admin User']
    );
    let whyWhyRow = null;
    if (w && w.id) {
      const wwRes = await client.query(
        `INSERT INTO why_why_log
          (id, breakdown_id, segment, machine_name, breakdown_date, downtime_hours,
           why1, why2, why3, why4, why5, root_cause, immediate_action, preventive_action,
           responsible_person, target_date, closure_remarks, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [w.id, b.id, w.segment || b.segment, w.machineName || b.machineName, w.breakdownDate || b.breakdownDate || null,
         w.downtimeHours || b.downtimeHours || 0, w.why1 || '', w.why2 || '', w.why3 || '', w.why4 || '', w.why5 || '',
         w.rootCause || '', w.immediateAction || '', w.preventiveAction || '', w.responsiblePerson || '',
         w.targetDate || null, w.closureRemarks || '', w.status || 'Open']
      );
      whyWhyRow = wwRes.rows[0];
    }
    await client.query('COMMIT');
    res.json({ breakdown: rowToBreakdown(rows[0]), whyWhy: whyWhyRow ? rowToWhyWhy(whyWhyRow) : null });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not save this breakdown entry', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /api/breakdown-log/bulk — CSV bulk import (breakdown entries only; the
// existing bulk import config does not create linked Why-Why records)
router.post('/bulk', requireRole('admin', 'superadmin'), async (req, res) => {
  const list = (req.body || {}).breakdowns;
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'breakdowns array is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const b of list) {
      if (!b.id || !b.machineName) continue;
      const { rows } = await client.query(
        `INSERT INTO breakdown_log
          (id, segment, machine_id, machine_name, breakdown_date, start_time, problem, category, priority,
           technician_id, technician_name, repair_start, repair_end, spare_parts_used, corrective_action,
           restoration_confirmed, status_after_repair, downtime_hours, why_why_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [b.id, b.segment, b.machineId, b.machineName, b.breakdownDate || null, b.startTime, b.problem, b.category, b.priority,
         b.technicianId, b.technicianName, b.repairStart || null, b.repairEnd || null, b.sparePartsUsed || '', b.correctiveAction || '',
         !!b.restorationConfirmed, b.statusAfterRepair, b.downtimeHours || 0, null, b.createdBy || 'Admin User']
      );
      created.push(rowToBreakdown(rows[0]));
    }
    await client.query('COMMIT');
    res.json({ breakdowns: created });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Bulk import failed', detail: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/why-why/:id — update an RCA record (progress save or close-out)
router.put('/why-why/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const w = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM why_why_log WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'RCA record not found' });
  const { rows } = await pool.query(
    `UPDATE why_why_log SET
       why1=$1, why2=$2, why3=$3, why4=$4, why5=$5, root_cause=$6, immediate_action=$7,
       preventive_action=$8, responsible_person=$9, target_date=$10, closure_remarks=$11,
       status=$12, closed_at=$13
     WHERE id=$14 RETURNING *`,
    [w.why1 || '', w.why2 || '', w.why3 || '', w.why4 || '', w.why5 || '', w.rootCause || '',
     w.immediateAction || '', w.preventiveAction || '', w.responsiblePerson || '', w.targetDate || null,
     w.closureRemarks || '', w.status || 'Open', w.closedAt || null, req.params.id]
  );
  res.json({ whyWhy: rowToWhyWhy(rows[0]) });
});

module.exports = router;
