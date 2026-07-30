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

// Is this BOM line untouched by production? Used by the edit and delete
// endpoints below to gate mutations to only lines that haven't been
// released to the shop floor yet. Any single indicator of production
// activity — released board qty, stage entries, QC decisions (approve or
// reject), spawned rework, non-empty history — locks the line. Rework
// lines are never eligible: they exist as a consequence of a QC rejection
// on some parent line, so editing their fields would break the rework
// chain and the reject_log audit trail that references them.
function isBomLineUntouched(row) {
  if (row.is_rework === true) return false;
  if ((row.components_released || 0) > 0) return false;
  const spawned = row.spawned_rework_line_ids;
  if (Array.isArray(spawned) && spawned.length > 0) return false;
  const sd = row.stage_data || {};
  for (const stageName of Object.keys(sd)) {
    const s = sd[stageName] || {};
    if ((s.completed || 0) > 0) return false;
    if ((s.qcApproved || 0) > 0) return false;
    if ((s.qcRejected || 0) > 0) return false;
    if ((s.rework    || 0) > 0) return false;
    if ((s.scrap     || 0) > 0) return false;
    if ((s.qcQueue   || 0) > 0) return false;
    if (Array.isArray(s.history) && s.history.length > 0) return false;
  }
  return true;
}

// Gate: only Production Admin (role='admin' AND department='Production')
// and Master Admin (role='superadmin') may edit or delete existing BOM
// lines. requireAuth already ran at the file level so req.user is
// populated; this helper only checks the role/department combination
// and writes a 403 if it doesn't match. Applied inline rather than as a
// requireRole extension because department is a new authorization axis
// not used elsewhere in the API.
function requireProductionOrMasterAdmin(req, res) {
  const u = req.user;
  const ok = u && (u.role === 'superadmin' || (u.role === 'admin' && u.department === 'Production'));
  if (!ok) {
    res.status(403).json({ error: 'Only Production Admin or Master Admin can edit or delete BOM lines' });
    return false;
  }
  return true;
}

// PUT /api/bom-lines/:lineId — edit an untouched BOM line. Whitelist of
// editable fields matches what New Project Entry captures; anything not
// in the whitelist is silently ignored to keep production-managed fields
// (stage_data, route, rework metadata, line_id, project_id) safe from
// accidental or malicious mutation. If item name changes, the route is
// re-derived from admin_config.componentRouting to match how New Project
// Entry auto-assigns routes, and stage_data is reset since the old stage
// keys don't apply to the new route (the line is untouched by definition,
// so no history is being discarded). Refuses with 409 if any production
// activity is present on the line — safer than allowing a stale edit to
// overwrite fresh production state in a race between two admins.
router.put('/:lineId', async (req, res) => {
  if (!requireProductionOrMasterAdmin(req, res)) return;
  try {
    const { rows } = await pool.query('SELECT * FROM bom_lines WHERE line_id = $1', [req.params.lineId]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'BOM line not found' });
    if (!isBomLineUntouched(row)) {
      return res.status(409).json({ error: 'Cannot edit — production activity exists on this line (stage entries, QC decisions, released quantity, or spawned rework). Only untouched lines can be edited.' });
    }

    const b = req.body || {};
    const sets = [];
    const vals = [];
    let i = 1;
    const push = (col, val) => { sets.push(col + ' = $' + i); vals.push(val); i++; };

    if (typeof b.item === 'string' && b.item.trim()) push('item', b.item.trim());
    if (b.l !== undefined)   push('l', b.l === '' || b.l === null ? null : Number(b.l));
    if (b.w !== undefined)   push('w', b.w === '' || b.w === null ? null : Number(b.w));
    if (b.t !== undefined)   push('t', b.t === '' || b.t === null ? null : Number(b.t));
    if (b.profile !== undefined) push('profile', b.profile || null);
    if (typeof b.uom === 'string') push('uom', b.uom.trim() || null);
    if (b.qty !== undefined) {
      const n = Number(b.qty);
      if (!Number.isFinite(n) || n < 1) return res.status(400).json({ error: 'qty must be a positive integer' });
      push('qty', Math.trunc(n));
      // Untouched line — original_qty tracks qty exactly. Once production
      // begins, original_qty freezes (drives rework-generation math), but
      // for a truly untouched line the two should stay in lockstep.
      push('original_qty', Math.trunc(n));
    }
    if (typeof b.colorFinish === 'string') push('color_finish', b.colorFinish);
    if (Array.isArray(b.specialChars))     push('special_chars', JSON.stringify(b.specialChars));
    if (b.componentsPerBoard !== undefined) push('components_per_board', b.componentsPerBoard === '' || b.componentsPerBoard === null ? null : Math.trunc(Number(b.componentsPerBoard)));
    if (b.edgeMetersPerComp !== undefined)  push('edge_meters_per_comp',  b.edgeMetersPerComp  === '' || b.edgeMetersPerComp  === null ? null : Number(b.edgeMetersPerComp));
    if (b.boardQty !== undefined)           push('board_qty',             b.boardQty           === '' || b.boardQty           === null ? null : Math.trunc(Number(b.boardQty)));

    // Route recomputation on item rename — matches how New Project Entry
    // auto-assigns routes via admin_config.componentRouting. If the new
    // name has no routing rule, route becomes an empty array and
    // production stalls at the first stage-entry attempt (same behavior
    // as New Project Entry today for an unmapped name).
    const newItem = typeof b.item === 'string' ? b.item.trim() : null;
    const oldItem = row.item;
    let routeReplaced = false;
    let newRouteLength = null;
    if (newItem && newItem !== oldItem) {
      const { rows: cr } = await pool.query("SELECT config_value FROM admin_config WHERE config_key = 'componentRouting'");
      const routingMap = (cr[0] && cr[0].config_value) || {};
      const newRoute = Array.isArray(routingMap[newItem]) ? routingMap[newItem] : [];
      push('route', JSON.stringify(newRoute));
      push('stage_data', '{}');
      routeReplaced = true;
      newRouteLength = newRoute.length;
    }

    if (!sets.length) {
      // Nothing to update — return the existing row unchanged rather than
      // running a no-op UPDATE.
      return res.json({ line: engine.withDefaults(row), routeReplaced, newRouteLength });
    }
    vals.push(req.params.lineId);
    const q = 'UPDATE bom_lines SET ' + sets.join(', ') + ' WHERE line_id = $' + i + ' RETURNING *';
    const { rows: out } = await pool.query(q, vals);
    res.json({ line: engine.withDefaults(out[0]), routeReplaced, newRouteLength });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/bom-lines/:lineId — delete an untouched BOM line. Returns
// the pre-delete row so the frontend can put it in the audit trail. The
// untouched test guarantees no reject_log rows (source_line_id or
// rework_line_id) or stage_log rows reference this line — both tables
// are populated only by production activity — so a plain DELETE is safe
// without needing a soft-delete column. Refuses with 409 if the line has
// any production activity, matching the PUT contract.
router.delete('/:lineId', async (req, res) => {
  if (!requireProductionOrMasterAdmin(req, res)) return;
  try {
    const { rows } = await pool.query('SELECT * FROM bom_lines WHERE line_id = $1', [req.params.lineId]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'BOM line not found' });
    if (!isBomLineUntouched(row)) {
      return res.status(409).json({ error: 'Cannot delete — production activity exists on this line. Only untouched lines can be deleted.' });
    }
    await pool.query('DELETE FROM bom_lines WHERE line_id = $1', [req.params.lineId]);
    res.json({ ok: true, deleted: engine.withDefaults(row) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
  const { stage, qty, operator, shift, remark, assBatchNos, adhesiveBatchNo, adhesiveExpiryDate } = req.body || {};
  if (!stage || !qty || !operator) return res.status(400).json({ error: 'stage, qty, and operator are required' });
  try {
    const result = await engine.submitStageEntry(req.params.lineId, { stageName: stage, qty: Number(qty), operator, shift, remark, assBatchNos, adhesiveBatchNo, adhesiveExpiryDate });
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

// POST /api/bom-lines/:lineId/mark-email-prompt-shown — flags a BOM line as
// having had the auto-open Handover Notification modal shown or explicitly
// skipped by the user. Once flagged, the frontend's auto-open trigger will
// not re-fire on subsequent QC actions or page refreshes for this line —
// the manual "Notify Handover" button in the component detail view is
// unaffected and continues to work regardless of the flag. Idempotent: safe
// to call even if the flag is already true.
router.post('/:lineId/mark-email-prompt-shown', requireRole('admin', 'superadmin'), async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE bom_lines SET email_prompt_shown = TRUE WHERE line_id = $1 RETURNING line_id',
    [req.params.lineId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'BOM line not found' });
  res.json({ ok: true, lineId: rows[0].line_id });
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
