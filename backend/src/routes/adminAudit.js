// Data-integrity tooling for the "progress can exceed 100%" bug (BOM lines
// whose last-stage qc_approved, or components_released, ended up above the
// line's own qty — see the capped cascade fix in productionEngine.js). This
// route surfaces existing bad rows and offers two remedies:
//   - recompute-progress: always safe, just re-derives projects.progress /
//     wood_status / ext_status from current bom_lines data (what already
//     happens on every QC decision — this just runs it for every project
//     once so already-stale cached values catch up).
//   - repair-overcounts: rewrites historical qc_approved / components_released
//     values down to each line's qty where they exceed it. This changes
//     stored QC records, so it's kept as an explicit, separate, admin-only
//     action rather than something recompute-progress does automatically.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withDefaults, refreshProjectProgress } = require('../lib/productionEngine');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'superadmin'));

function lastStageOf(route) {
  return Array.isArray(route) && route.length ? route[route.length - 1] : null;
}

async function findOvercounted() {
  const { rows: lines } = await pool.query(
    `SELECT line_id, project_id, item, seg, qty, components_released, route, stage_data FROM bom_lines`
  );
  const { rows: projects } = await pool.query(
    `SELECT id, sap, customer, progress FROM projects`
  );
  const projById = {};
  projects.forEach((p) => { projById[p.id] = p; });

  const badLines = [];
  lines.forEach((row) => {
    const line = withDefaults({ ...row });
    const ls = lastStageOf(line.route);
    const qcApproved = ls ? Number((line.stage_data[ls] || {}).qc_approved) || 0 : 0;
    const qty = Number(line.qty) || 0;
    const released = Number(line.components_released) || 0;
    if (qcApproved > qty || released > qty) {
      badLines.push({
        projectId: line.project_id,
        sap: projById[line.project_id] ? projById[line.project_id].sap : '?',
        lineId: line.line_id,
        item: line.item,
        seg: line.seg,
        qty,
        lastStage: ls,
        qcApproved,
        componentsReleased: released,
      });
    }
  });

  const badProjects = projects
    .filter((p) => Number(p.progress) > 100)
    .map((p) => ({ id: p.id, sap: p.sap, customer: p.customer, progress: p.progress }));

  return { badLines, badProjects, totalLinesChecked: lines.length, totalProjectsChecked: projects.length };
}

// GET /api/admin-audit/report — read-only.
router.get('/report', async (req, res) => {
  try {
    const result = await findOvercounted();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-audit/recompute-progress — safe: re-derives progress/status
// for every project from its current bom_lines, same formula already used
// live on every QC decision. No historical values touched.
router.post('/recompute-progress', async (req, res) => {
  try {
    const { rows: projects } = await pool.query('SELECT id, progress FROM projects');
    let changed = 0;
    for (const p of projects) {
      await refreshProjectProgress(pool, p.id);
      const { rows } = await pool.query('SELECT progress FROM projects WHERE id = $1', [p.id]);
      if (rows[0] && Number(rows[0].progress) !== Number(p.progress)) changed++;
    }
    res.json({ projectsChecked: projects.length, projectsChanged: changed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin-audit/repair-overcounts — caps last-stage qc_approved and
// components_released down to each line's own qty wherever they exceed it,
// then recomputes progress for every affected project. Mutates historical
// QC data, so this is a separate, explicit call from recompute-progress.
router.post('/repair-overcounts', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { badLines } = await findOvercounted();
    const affectedProjects = new Set();
    for (const bad of badLines) {
      const { rows } = await client.query('SELECT * FROM bom_lines WHERE line_id = $1 FOR UPDATE', [bad.lineId]);
      if (!rows.length) continue;
      const line = withDefaults({ ...rows[0] });
      const ls = lastStageOf(line.route);
      if (ls && (line.stage_data[ls].qc_approved || 0) > line.qty) {
        line.stage_data[ls].qc_approved = line.qty;
      }
      if ((line.components_released || 0) > line.qty) {
        line.components_released = line.qty;
      }
      await client.query(
        'UPDATE bom_lines SET stage_data = $1, components_released = $2 WHERE line_id = $3',
        [JSON.stringify(line.stage_data), line.components_released, line.line_id]
      );
      affectedProjects.add(bad.projectId);
    }
    await client.query('COMMIT');

    for (const projectId of affectedProjects) {
      await refreshProjectProgress(pool, projectId);
    }

    res.json({ linesRepaired: badLines.length, projectsRecomputed: affectedProjects.size });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
