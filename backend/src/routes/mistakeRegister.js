const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function rowToMistake(row) {
  return {
    id: row.id,
    description: row.description,
    mistakeDate: row.mistake_date,
    projectId: row.project_id,
    proj: row.project_sap,
    department: row.department,
    responsiblePerson: row.responsible_person,
    process: row.process,
    actionTaken: row.action_taken,
    remarks: row.remarks,
    attachmentData: row.attachment_data,
    attachmentName: row.attachment_name,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    history: row.history || [],
  };
}

// GET /api/mistake-register — full register, most recently created first.
// Filtering (department/date/project/process/status/person) is done
// client-side against this full list, matching how every other log/history
// table in this app already works.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM mistake_register ORDER BY created_at DESC');
  res.json({ mistakes: rows.map(rowToMistake) });
});

// POST /api/mistake-register — record a new mistake/issue
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.description) return res.status(400).json({ error: 'description is required' });
  if (!b.department) return res.status(400).json({ error: 'department is required' });
  const id = 'MR-' + String(Date.now()).slice(-8);
  const history = [{ ts: new Date().toISOString(), user: b.createdBy || 'Unknown', action: 'Recorded' }];
  const { rows } = await pool.query(
    `INSERT INTO mistake_register (
       id, description, mistake_date, project_id, project_sap, department, responsible_person,
       process, action_taken, remarks, attachment_data, attachment_name, status, created_by, history
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      id, b.description, b.mistakeDate || null, b.projectId || null, b.proj || '',
      b.department, b.responsiblePerson || '', b.process || '', b.actionTaken || '', b.remarks || '',
      b.attachmentData || null, b.attachmentName || null, 'Open', b.createdBy || 'Unknown', JSON.stringify(history),
    ]
  );
  res.status(201).json({ mistake: rowToMistake(rows[0]) });
});

// PUT /api/mistake-register/:id — update details, or close the record
router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM mistake_register WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Record not found' });
  const existing = existingRows[0];
  const history = existing.history || [];
  const actor = b.updatedBy || 'Unknown';

  const newStatus = b.status || existing.status;
  const isClosing = newStatus === 'Closed' && existing.status !== 'Closed';
  const isReopening = newStatus === 'Open' && existing.status !== 'Open';
  if (isClosing) history.push({ ts: new Date().toISOString(), user: actor, action: 'Closed' });
  else if (isReopening) history.push({ ts: new Date().toISOString(), user: actor, action: 'Reopened' });
  else if (b.actionTaken !== undefined && b.actionTaken !== existing.action_taken) {
    history.push({ ts: new Date().toISOString(), user: actor, action: 'Action/remarks updated' });
  }

  const closedBy = isClosing ? actor : (isReopening ? null : existing.closed_by);
  const closedAt = isClosing ? new Date().toISOString() : (isReopening ? null : existing.closed_at);

  const { rows } = await pool.query(
    `UPDATE mistake_register SET
       description=$1, mistake_date=$2, project_id=$3, project_sap=$4, department=$5, responsible_person=$6,
       process=$7, action_taken=$8, remarks=$9, attachment_data=$10, attachment_name=$11, status=$12,
       closed_by=$13, closed_at=$14, history=$15
     WHERE id=$16 RETURNING *`,
    [
      b.description ?? existing.description, b.mistakeDate ?? existing.mistake_date,
      b.projectId ?? existing.project_id, b.proj ?? existing.project_sap,
      b.department ?? existing.department, b.responsiblePerson ?? existing.responsible_person,
      b.process ?? existing.process, b.actionTaken ?? existing.action_taken, b.remarks ?? existing.remarks,
      (b.attachmentData !== undefined ? b.attachmentData : existing.attachment_data),
      (b.attachmentName !== undefined ? b.attachmentName : existing.attachment_name),
      newStatus, closedBy, closedAt, JSON.stringify(history), req.params.id,
    ]
  );
  res.json({ mistake: rowToMistake(rows[0]) });
});

// DELETE /api/mistake-register/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM mistake_register WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Record not found' });
  res.json({ ok: true, id: rows[0].id });
});

module.exports = router;
