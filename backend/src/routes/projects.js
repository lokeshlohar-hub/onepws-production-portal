const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../lib/productionEngine');

const router = express.Router();
router.use(requireAuth);

// GET /api/projects — list all projects, each with its full BOM embedded
// (the frontend needs this to populate DB.projects in one shot on login)
router.get('/', async (req, res) => {
  const projRes = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  const bomRes = await pool.query('SELECT * FROM bom_lines ORDER BY created_at');
  const bomByProject = {};
  bomRes.rows.forEach((row) => {
    const line = engine.withDefaults(row);
    (bomByProject[line.project_id] = bomByProject[line.project_id] || []).push(line);
  });
  const projects = projRes.rows.map((p) => ({ ...p, bom: bomByProject[p.id] || [] }));
  res.json({ projects });
});

// GET /api/projects/:id — single project with its full BOM
router.get('/:id', async (req, res) => {
  const projRes = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!projRes.rows[0]) return res.status(404).json({ error: 'Project not found' });
  const bomRes = await pool.query('SELECT * FROM bom_lines WHERE project_id = $1 ORDER BY created_at', [req.params.id]);
  const bom = bomRes.rows.map((row) => engine.withDefaults(row));
  res.json({ project: projRes.rows[0], bom });
});

// POST /api/projects — create a new project with its BOM lines.
// Body: { sap, type, category, customer, pm, eng, po, hasWood, hasExt,
//         recWood, planWood, recExt, planExt, certifications,
//         bom: [{ item, seg, l, w, t, profile, uom, qty, colorFinish, specialChars,
//                  componentsPerBoard, edgeMetersPerComp, boardQty, route }] }
// `route` for each BOM line must be supplied by the caller (it comes from the
// admin-configured M.componentRouting master data, which still lives on the
// frontend for Phase 1 — see productionEngine.js header comment).
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
         rec_wood, plan_wood, rec_ext, plan_ext, certifications, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        projectId, body.sap, body.type, body.category, body.customer, body.pm, body.eng, body.po || '',
        !!body.hasWood, !!body.hasExt,
        body.recWood || null, body.planWood || null, body.recExt || null, body.planExt || null,
        JSON.stringify(body.certifications || []), req.user.id,
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

// DELETE /api/projects/:id — permanently deletes the project and everything
// tied to it (BOM lines, reject log entries, stage log entries) via the
// ON DELETE CASCADE foreign keys already in the schema. This does not touch
// dailyCap/dailyManpower-equivalent capacity history, since that data is
// shared across projects at the workstation level, not project-specific.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const projRes = await pool.query('SELECT id, sap FROM projects WHERE id = $1', [req.params.id]);
  if (!projRes.rows[0]) return res.status(404).json({ error: 'Project not found' });
  await pool.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.json({ ok: true, deletedProjectId: req.params.id, sap: projRes.rows[0].sap });
});

module.exports = router;
