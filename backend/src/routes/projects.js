const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../lib/productionEngine');

const router = express.Router();
router.use(requireAuth);

// One-time schema-init — ensures the projects table has every column the
// current feature set needs. Idempotent: ADD COLUMN IF NOT EXISTS is a no-op
// after the first successful run, so it's safe on every server start.
//   - docs          : v50, attachments attached during BOM creation
//   - job_work_po   : v54.1, Aluminum Extrusion Job Work PO No.
//   - remarks       : v54.1, project-level remarks (Update Stage + Overview)
//   - on_hold + hold_reason/remarks/date/held_by : v54.1, Project Hold persistence
(async () => {
  try {
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS docs JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS job_work_po TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS on_hold BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS hold_reason TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS hold_remarks TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS hold_date DATE`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS held_by INTEGER`);
  } catch (err) {
    console.error('[schema-init] Failed to ensure projects columns:', err.message);
  }
})();

// Decorate a raw snake_case DB row with camelCase aliases so the frontend
// (which reads p.onHold, p.holdReason, p.jobWorkPO) works without a separate
// mapping layer. Leaves the original snake_case fields intact for backward
// compatibility with any consumer that expects them.
function withAliases(p) {
  if (!p) return p;
  return {
    ...p,
    onHold:      !!p.on_hold,
    holdReason:  p.hold_reason  || '',
    holdRemarks: p.hold_remarks || '',
    holdDate:    p.hold_date,
    jobWorkPO:   p.job_work_po  || '',
    // p.remarks passes through unchanged (name already matches)
  };
}

// GET /api/projects — list all projects, each with its full BOM embedded
router.get('/', async (req, res) => {
  const projRes = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  const bomRes  = await pool.query('SELECT * FROM bom_lines ORDER BY created_at');
  const bomByProject = {};
  bomRes.rows.forEach((row) => {
    const line = engine.withDefaults(row);
    (bomByProject[line.project_id] = bomByProject[line.project_id] || []).push(line);
  });
  const projects = projRes.rows.map((p) => ({ ...withAliases(p), bom: bomByProject[p.id] || [] }));
  res.json({ projects });
});

// GET /api/projects/:id — single project with its full BOM
router.get('/:id', async (req, res) => {
  const projRes = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!projRes.rows[0]) return res.status(404).json({ error: 'Project not found' });
  const bomRes = await pool.query('SELECT * FROM bom_lines WHERE project_id = $1 ORDER BY created_at', [req.params.id]);
  const bom = bomRes.rows.map((row) => engine.withDefaults(row));
  res.json({ project: withAliases(projRes.rows[0]), bom });
});

// POST /api/projects — create a new project with its BOM lines
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const body = req.body || {};
  if (!body.sap || !Array.isArray(body.bom) || !body.bom.length) {
    return res.status(400).json({ error: 'sap and at least one BOM line are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const projectId = await engine.nextProjectId(client);

    await client.query(
      `INSERT INTO projects (id, sap, type, category, customer, pm, eng, po, has_wood, has_ext,
         rec_wood, plan_wood, rec_ext, plan_ext, certifications, docs, job_work_po, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        projectId, body.sap, body.type, body.category, body.customer, body.pm, body.eng, body.po || '',
        !!body.hasWood, !!body.hasExt,
        body.recWood || null, body.planWood || null, body.recExt || null, body.planExt || null,
        JSON.stringify(body.certifications || []),
        JSON.stringify(Array.isArray(body.docs) ? body.docs : []),
        body.jobWorkPO || '',
        body.remarks || '',
        req.user.id,
      ]
    );

    const createdLines = [];
    for (const b of body.bom) {
      const lineId = await engine.nextBomLineId(client);
      const route = Array.isArray(b.route) ? b.route : [];
      const stageData = {};
      route.forEach((st) => { stageData[st] = { completed: 0, qc_queue: 0, qc_approved: 0, qc_rejected: 0, rework: 0, scrap: 0, history: [] }; });

      await client.query(
        `INSERT INTO bom_lines (
           line_id, project_id, item, seg, l, w, t, profile, uom, qty, original_qty,
           color_finish, special_chars, components_per_board, edge_meters_per_comp,
           board_qty, components_released, route, stage_data
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,0,$16,$17)`,
        [
          lineId, projectId, b.item, b.seg || 'wood', b.l || null, b.w || null, b.t || null, b.profile || null,
          b.uom || 'PC', b.qty,
          b.colorFinish || '', JSON.stringify(b.specialChars || []),
          b.componentsPerBoard || null, b.edgeMetersPerComp || null,
          b.boardQty || Math.max(1, Math.ceil(b.qty / (b.componentsPerBoard || 8))),
          JSON.stringify(route), JSON.stringify(stageData),
        ]
      );
      createdLines.push(lineId);
    }

    await client.query('COMMIT');
    res.status(201).json({ projectId, bomLineIds: createdLines });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A project with this SAP number already exists' });
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/projects/:id/add-segment — additive Wood or Extrusion segment
router.post('/:id/add-segment', requireRole('admin', 'superadmin'), async (req, res) => {
  const body = req.body || {};
  const { segment } = body;
  if (segment !== 'wood' && segment !== 'ext') {
    return res.status(400).json({ error: 'segment must be "wood" or "ext"' });
  }
  if (!Array.isArray(body.bom) || !body.bom.length) {
    return res.status(400).json({ error: 'At least one BOM line is required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projRows } = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!projRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Project not found' }); }
    const proj = projRows[0];
    const segmentAlreadyExists = segment === 'wood' ? proj.has_wood : proj.has_ext;

    if (!segmentAlreadyExists) {
      if (segment === 'wood') {
        await client.query('UPDATE projects SET has_wood = true, rec_wood = $1, plan_wood = $2 WHERE id = $3',
          [body.received || null, body.tat || null, req.params.id]);
      } else {
        // Extrusion — persist job_work_po alongside the new segment if provided
        await client.query(
          `UPDATE projects SET has_ext = true, rec_ext = $1, plan_ext = $2,
             job_work_po = COALESCE(NULLIF($3, ''), job_work_po)
           WHERE id = $4`,
          [body.received || null, body.tat || null, body.jobWorkPO || '', req.params.id]);
      }
    } else if (segment === 'ext' && body.jobWorkPO) {
      // Segment already exists — still allow PO to be updated on re-save
      await client.query('UPDATE projects SET job_work_po = $1 WHERE id = $2',
        [body.jobWorkPO, req.params.id]);
    }

    const createdLines = [];
    for (const b of body.bom) {
      const lineId = await engine.nextBomLineId(client);
      const route = Array.isArray(b.route) ? b.route : [];
      const stageData = {};
      route.forEach((st) => { stageData[st] = { completed: 0, qc_queue: 0, qc_approved: 0, qc_rejected: 0, rework: 0, scrap: 0, history: [] }; });

      await client.query(
        `INSERT INTO bom_lines (
           line_id, project_id, item, seg, l, w, t, profile, uom, qty, original_qty,
           color_finish, special_chars, components_per_board, edge_meters_per_comp,
           board_qty, components_released, route, stage_data
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,0,$16,$17)`,
        [
          lineId, req.params.id, b.item, segment, b.l || null, b.w || null, b.t || null, b.profile || null,
          b.uom || 'PC', b.qty,
          b.colorFinish || '', JSON.stringify(b.specialChars || []),
          b.componentsPerBoard || null, b.edgeMetersPerComp || null,
          b.boardQty || Math.max(1, Math.ceil(b.qty / (b.componentsPerBoard || 8))),
          JSON.stringify(route), JSON.stringify(stageData),
        ]
      );
      createdLines.push(lineId);
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, projectId: req.params.id, bomLineIds: createdLines });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/projects/:id — partial update for project-level fields.
// Currently accepts: remarks, jobWorkPO. Extensible: add fields as needed.
router.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = [];
  let i = 1;
  if (body.remarks !== undefined)   { updates.push(`remarks = $${i++}`);     values.push(String(body.remarks)); }
  if (body.jobWorkPO !== undefined) { updates.push(`job_work_po = $${i++}`); values.push(String(body.jobWorkPO)); }
  if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });
  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE projects SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, remarks, job_work_po`,
    values
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
  const row = result.rows[0];
  res.json({ ok: true, project: { id: row.id, remarks: row.remarks, jobWorkPO: row.job_work_po } });
});

// POST /api/projects/:id/hold — place a project on Hold. Body: { reason, remarks }
router.post('/:id/hold', requireRole('admin', 'superadmin'), async (req, res) => {
  const { reason, remarks } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'reason is required' });
  const today = new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    `UPDATE projects
       SET on_hold = TRUE,
           hold_reason  = $1,
           hold_remarks = $2,
           hold_date    = $3,
           held_by      = $4
     WHERE id = $5
     RETURNING id, on_hold, hold_reason, hold_remarks, hold_date`,
    [String(reason).trim(), String(remarks || '').trim(), today, req.user.id, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
  const row = result.rows[0];
  res.json({
    ok: true,
    project: {
      id: row.id,
      onHold: row.on_hold,
      holdReason: row.hold_reason,
      holdRemarks: row.hold_remarks,
      holdDate: row.hold_date,
    },
  });
});

// POST /api/projects/:id/resume — release a project from Hold
router.post('/:id/resume', requireRole('admin', 'superadmin'), async (req, res) => {
  const result = await pool.query(
    `UPDATE projects
       SET on_hold      = FALSE,
           hold_reason  = '',
           hold_remarks = '',
           hold_date    = NULL,
           held_by      = NULL
     WHERE id = $1
     RETURNING id, on_hold`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true, project: { id: result.rows[0].id, onHold: false } });
});

// DELETE /api/projects/:id — permanent delete, cascades to BOM and logs
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const projRes = await pool.query('SELECT id, sap FROM projects WHERE id = $1', [req.params.id]);
  if (!projRes.rows[0]) return res.status(404).json({ error: 'Project not found' });
  await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ ok: true, deletedProjectId: req.params.id, sap: projRes.rows[0].sap });
});

module.exports = router;