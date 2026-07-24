const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../lib/productionEngine');

const router = express.Router();
router.use(requireAuth);

// GET /api/bom-lines/:lineId — single BOM line (with computed pending/eligible per stage)
router.get('/:lineId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bom_lines WHERE line_id = $1', [req.params.lineId]);
  if (!rows[0]) return res.status(404).json({ error: 'BOM line not found' });
  const line = engine.withDefaults(rows[0]);
  const trace = line.route.map((stage) => ({
    stage,
    eligible: engine.eligibleInputQty(line, stage),
    pending: engine.pendingQty(line, stage),
    ...line.stage_data[stage],
  }));
  res.json({ line, trace, isComplete: engine.isComponentComplete(line) });
});

// GET /api/qc-queue — everything currently awaiting QC, across all projects
// (mirrors the frontend's renderQcQueue())
router.get('/qc/queue', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT bl.*, p.sap AS project_sap
    FROM bom_lines bl JOIN projects p ON p.id = bl.project_id
  `);
  const queue = [];
  rows.forEach((row) => {
    const line = engine.withDefaults(row);
    line.route.forEach((stage, i) => {
      const sd = line.stage_data[stage];
      if (sd.qc_queue > 0) {
        queue.push({
          projectId: line.project_id,
          projectSap: row.project_sap,
          lineId: line.line_id,
          item: line.item,
          isRework: line.is_rework,
          stage,
          qty: sd.qc_queue,
          nextStage: line.route[i + 1] || 'Final (Last Stage)',
        });
      }
    });
  });
  res.json({ queue });
});

// POST /api/bom-lines/:lineId/stage-entry — operator submits completed qty at a stage
// Body: { stage, qty, operator, shift, remark }
router.post('/:lineId/stage-entry', requireRole('admin', 'superadmin'), async (req, res) => {
  const { stage, qty, operator, shift, remark } = req.body || {};
  if (!stage || !qty || !operator) return res.status(400).json({ error: 'stage, qty, and operator are required' });
  try {
    const result = await engine.submitStageEntry(req.params.lineId, { stageName: stage, qty: Number(qty), operator, shift, remark });
    res.json({ ok: true, line: result.line });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/bom-lines/:lineId/qc-decision — QC records approve/reject.
// Body: { stage, approveQty, rejectQty, disposition, category, qcPerson, remarks, instrument }
// disposition 'rework' automatically spawns a new BOM line — this is the
// endpoint that answers "did the rejected component get added back to the BOM".
router.post('/:lineId/qc-decision', requireRole('admin', 'superadmin'), async (req, res) => {
  const { stage, approveQty, rejectQty, disposition, category, qcPerson, remarks, instrument, photoData } = req.body || {};
  if (!stage || approveQty == null || rejectQty == null || !qcPerson) {
    return res.status(400).json({ error: 'stage, approveQty, rejectQty, and qcPerson are required' });
  }
  if (rejectQty > 0 && !category) return res.status(400).json({ error: 'category is required when rejecting a quantity' });
  try {
    const result = await engine.processQcDecision(req.params.lineId, {
      stageName: stage,
      approveQty: Number(approveQty),
      rejectQty: Number(rejectQty),
      disposition: disposition || 'rework',
      category, qcPerson, remarks, instrument, photoData,
    });
    res.json({
      ok: true,
      originalLine: result.originalLine,
      reworkLine: result.reworkLine,
      projectProgress: result.projectProgress,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/reject-log — full reject/rework log, optionally filtered by project
router.get('/qc/reject-log', async (req, res) => {
  const { projectId } = req.query;
  const { rows } = projectId
    ? await pool.query('SELECT * FROM reject_log WHERE project_id = $1 ORDER BY ts DESC', [projectId])
    : await pool.query('SELECT * FROM reject_log ORDER BY ts DESC LIMIT 200');
  res.json({ rejectLog: rows });
});

// PUT /api/bom-lines/:lineId/reconcile-route — narrowly-scoped self-healing
// correction for a specific, recurring failure mode: a stage name in this
// line's route/stage_data ends up with different case/whitespace than the
// Process Group it's supposed to reference (e.g. "Cleaning unit" vs
// "Cleaning Unit"), which silently breaks the machine lookup at production
// execution. This only renames stage-name keys/entries — every quantity, QC
// count, and history entry in stage_data is carried over unchanged.
router.put('/:lineId/reconcile-route', requireRole('admin', 'superadmin'), async (req, res) => {
  const { route, stageData } = req.body || {};
  if (!Array.isArray(route) || typeof stageData !== 'object') {
    return res.status(400).json({ error: 'route (array) and stageData (object) are required' });
  }
  const { rows } = await pool.query(
    'UPDATE bom_lines SET route = $1, stage_data = $2 WHERE line_id = $3 RETURNING line_id',
    [JSON.stringify(route), JSON.stringify(stageData), req.params.lineId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'BOM line not found' });
  res.json({ ok: true, lineId: rows[0].line_id });
});

module.exports = router;
