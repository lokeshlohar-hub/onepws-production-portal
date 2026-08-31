const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

const CHECKLIST_TEMPLATE = [
  { srNo: '1', point: 'Dimensional Checking L x B x H (mm)', mode: 'Measuring Tape / Vernier Caliper / Degree Protractor', criteria: 'As Per Drawing Dimensions.', tolerance: 'As per ISO 2768 Tolerance Table mentioned on Drawing Template' },
  { srNo: '2', point: 'Check for Burrs', mode: 'Visual', criteria: 'If there are no burrs', tolerance: 'No Tolerance Allowed' },
  { srNo: '3', point: 'Check for Cracks', mode: 'Visual', criteria: 'If there are no cracks', tolerance: 'No Tolerance Allowed' },
  { srNo: '4', point: 'Check for Unwanted Bend', mode: 'Visual', criteria: 'If it is without bend', tolerance: 'No Tolerance Allowed' },
  { srNo: '5', point: 'Check for Sharp Edges', mode: 'Visual', criteria: 'If there are no sharp edges', tolerance: 'No Tolerance Allowed' },
  { srNo: '6', point: 'Check for Dents', mode: 'Visual', criteria: 'If there are no dents', tolerance: 'No Tolerance Allowed' },
  { srNo: '7', point: 'Check for Corners', mode: 'Visual', criteria: 'Should be Uniform', tolerance: 'No Tolerance Allowed' },
  { srNo: '8', point: 'Check for Grinding Marks', mode: 'Visual', criteria: 'Should be Uniform', tolerance: 'No Tolerance Allowed' },
  { srNo: '9', point: 'Check For Hanging Holes for Powder Coating', mode: 'Visual', criteria: 'Should be at extreme corner of 2-3mm diameter at the rear/hidden face of extrusion', tolerance: 'No Tolerance Allowed' },
  { srNo: '10', point: 'Check For Line Marks', mode: 'Visual', criteria: 'If there are no line marks', tolerance: 'No Tolerance Allowed' },
  { srNo: '11', point: 'Check For Scratches', mode: 'Visual', criteria: 'If there are no scratches', tolerance: 'No Tolerance Allowed' },
  { srNo: '12', point: 'Check For Surface finish', mode: 'Visual', criteria: 'If there is no quality issue.', tolerance: 'No Tolerance Allowed' },
  { srNo: '13', point: 'Joinery Hole Diameter and Distance from the edge', mode: 'Measurement', criteria: 'As Per Drawing Dimensions.', tolerance: 'As per ISO 2768 Tolerance Table' },
];
// Checkpoints 2-13 only — checked ONCE for the whole batch, not per component.
// Checkpoint 1 (Dimensional) is NOT in here; it's rendered directly from the
// component list (job_work_outward_lines), since each component's own
// offered/accepted/rejected/final-status numbers already cover it.
const SHARED_CHECKLIST_TEMPLATE = CHECKLIST_TEMPLATE.filter(c => c.srNo !== '1');
function defaultSharedChecklist() {
  return SHARED_CHECKLIST_TEMPLATE.map(c => ({ ...c, result: '', remarks: '' }));
}

async function nextJwoId(client) {
  const { rows } = await client.query("SELECT nextval('jwo_id_seq') AS n");
  return 'JWO-' + String(rows[0].n).padStart(5, '0');
}
async function nextJwolId(client) {
  const { rows } = await client.query("SELECT nextval('jwol_id_seq') AS n");
  return 'JWOL-' + String(rows[0].n).padStart(5, '0');
}

router.get('/eligible/:projectId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT bl.line_id, bl.item, bl.l, bl.w, bl.t, bl.profile, bl.color_finish, bl.qty,
              COALESCE((
                SELECT SUM(jwol.qty_offered) FROM job_work_outward_lines jwol
                WHERE jwol.bom_line_id = bl.line_id
              ), 0) AS previously_sent
       FROM bom_lines bl
       WHERE bl.project_id = $1 AND bl.seg = 'ext'
       ORDER BY bl.line_id`,
      [req.params.projectId]
    );
    const lines = rows.map(r => ({
      bomLineId: r.line_id,
      item: r.item,
      l: r.l, w: r.w, t: r.t, profile: r.profile, colorFinish: r.color_finish,
      qty: r.qty,
      previouslySent: Number(r.previously_sent),
      remaining: r.qty - Number(r.previously_sent),
    }));
    res.json({ lines });
  } catch (err) {
    res.status(500).json({ error: 'Could not load eligible components', detail: err.message });
  }
});

router.get('/project/:projectId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT jwo.*, COALESCE(SUM(jwol.qty_offered),0) AS total_offered
       FROM job_work_outward jwo
       LEFT JOIN job_work_outward_lines jwol ON jwol.job_work_outward_id = jwo.id
       WHERE jwo.project_id = $1
       GROUP BY jwo.id
       ORDER BY jwo.created_at DESC`,
      [req.params.projectId]
    );
    res.json({ outwards: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load job work outward history', detail: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { rows: hdr } = await pool.query('SELECT * FROM job_work_outward WHERE id = $1', [req.params.id]);
    if (!hdr[0]) return res.status(404).json({ error: 'Not found' });
    const { rows: lines } = await pool.query(
      `SELECT jwol.*, bl.item, bl.l, bl.w, bl.t, bl.profile, bl.color_finish
       FROM job_work_outward_lines jwol
       JOIN bom_lines bl ON bl.line_id = jwol.bom_line_id
       WHERE jwol.job_work_outward_id = $1
       ORDER BY jwol.id`,
      [req.params.id]
    );
    res.json({ outward: hdr[0], lines });
  } catch (err) {
    res.status(500).json({ error: 'Could not load job work outward', detail: err.message });
  }
});

router.post('/', async (req, res) => {
  const { projectId, dateOfInspection, operatorName, lines } = req.body || {};
  if (!projectId || !Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'projectId and at least one line are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projRows } = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (!projRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Project not found' }); }

    for (const l of lines) {
      if (!l.bomLineId || !(l.qtyOffered > 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Every line needs a bomLineId and a qtyOffered greater than 0' });
      }
      const { rows: blRows } = await client.query(
        "SELECT * FROM bom_lines WHERE line_id = $1 AND project_id = $2 AND seg = 'ext' FOR UPDATE",
        [l.bomLineId, projectId]
      );
      if (!blRows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'BOM component not found on this project: ' + l.bomLineId });
      }
      const { rows: sentRows } = await client.query(
        'SELECT COALESCE(SUM(qty_offered),0) AS s FROM job_work_outward_lines WHERE bom_line_id = $1',
        [l.bomLineId]
      );
      const remaining = blRows[0].qty - Number(sentRows[0].s);
      if (l.qtyOffered > remaining) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `${blRows[0].item}: only ${remaining} remaining, cannot send ${l.qtyOffered}` });
      }
    }

    const jwoId = await nextJwoId(client);
    await client.query(
      `INSERT INTO job_work_outward (id, project_id, report_no, date_of_inspection, operator_name, status, created_by, checklist_results)
       VALUES ($1,$2,$1,$3,$4,'draft',$5,$6)`,
      [jwoId, projectId, dateOfInspection || new Date().toISOString().split('T')[0], operatorName || 'Mr Bhagwat Singh', req.user.id, JSON.stringify(defaultSharedChecklist())]
    );

    for (const l of lines) {
      const jwolId = await nextJwolId(client);
      await client.query(
        `INSERT INTO job_work_outward_lines (id, job_work_outward_id, bom_line_id, qty_offered)
         VALUES ($1,$2,$3,$4)`,
        [jwolId, jwoId, l.bomLineId, l.qtyOffered]
      );
    }

    await client.query('COMMIT');
    res.json({ id: jwoId, reportNo: jwoId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not create job work outward', detail: err.message });
  } finally {
    client.release();
  }
});

router.put('/:id/qc', async (req, res) => {
  const { qcPerson, qcRemarks, checklistResults, lines } = req.body || {};
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'At least one line is required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: hdrRows } = await client.query('SELECT * FROM job_work_outward WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!hdrRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }

    for (const l of lines) {
      const { rows: lineRows } = await client.query(
        'SELECT * FROM job_work_outward_lines WHERE id = $1 AND job_work_outward_id = $2 FOR UPDATE',
        [l.id, req.params.id]
      );
      if (!lineRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Line not found: ' + l.id }); }
      const offered = lineRows[0].qty_offered;
      const accepted = l.qtyAccepted || 0;
      const rejected = l.qtyRejected || 0;
      const rework = l.qtyRework || 0;
      if (accepted + rejected + rework > offered) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Accepted + Rejected + Rework (${accepted + rejected + rework}) exceeds Offered (${offered}) for line ${l.id}` });
      }
      await client.query(
        `UPDATE job_work_outward_lines
         SET qty_accepted = $1, qty_rejected = $2, qty_rework = $3, final_status = $4
         WHERE id = $5`,
        [accepted, rejected, rework, l.finalStatus || null, l.id]
      );
    }

    await client.query(
      `UPDATE job_work_outward SET qc_person = $1, qc_remarks = $2, checklist_results = $3, status = 'completed' WHERE id = $4`,
      [qcPerson || '', qcRemarks || '', JSON.stringify(checklistResults || []), req.params.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not save QC results', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;