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
//   - drawing_wood, drawing_ext : v54.6, per-segment Drawing/File Reference —
//     previously entered at project creation but only kept in an in-memory
//     sub-object that was never sent to the server, so it vanished on reload
(async () => {
  try {
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS docs JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS job_work_po TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS drawing_wood TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS drawing_ext TEXT NOT NULL DEFAULT ''`);
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
    drawingWood: p.drawing_wood || '',
    drawingExt:  p.drawing_ext  || '',
    // p.remarks passes through unchanged (name already matches)
  };
}

// GET /api/projects is polled by every open screen every 30 s (index.html
// performAutoRefresh). Re-reading every project and every BOM line on each
// poll shipped ~1.5 MB out of the database per call and exhausted the
// Supabase organisation's egress quota within a week. So the full read only
// happens when the data actually changed: a one-row fingerprint of both
// tables is checked first.
//
// The fingerprint is computed from the rows themselves — row count plus a sum
// of hashes of each row version's physical id (ctid) and creating transaction
// (xmin) — so it changes on ANY insert, update or delete, whichever route or
// engine function (or manual SQL) made it. Plain max(xmin) is NOT enough: a
// long transaction that commits after a newer one leaves max(xmin) unchanged.
// Table housekeeping (VACUUM FULL / CLUSTER) can also change it, which only
// costs one extra full read.
const LIST_FINGERPRINT_SQL = `
  SELECT
    (SELECT count(*)::text || ':' || coalesce(sum(hashtext(ctid::text || '/' || xmin::text)::bigint), 0)::text FROM projects)  AS p,
    (SELECT count(*)::text || ':' || coalesce(sum(hashtext(ctid::text || '/' || xmin::text)::bigint), 0)::text FROM bom_lines) AS b`;

let listCache = null;   // { fp, payload } — identical for every user
let listLoading = null; // { fp, promise } — one full read at a time per fingerprint

async function readProjectList() {
  const projRes = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  const bomRes  = await pool.query('SELECT * FROM bom_lines ORDER BY created_at');
  const bomByProject = {};
  bomRes.rows.forEach((row) => {
    const line = engine.withDefaults(row);
    (bomByProject[line.project_id] = bomByProject[line.project_id] || []).push(line);
  });
  const projects = projRes.rows.map((p) => ({ ...withAliases(p), bom: bomByProject[p.id] || [] }));
  return { projects };
}

// A write landing between the fingerprint check and the full read is safe:
// the newer data is cached under the older fingerprint, so the next poll sees
// a different fingerprint and reads again. Data is never served stale for
// longer than one poll.
async function getProjectList() {
  const { rows: [f] } = await pool.query(LIST_FINGERPRINT_SQL);
  const fp = `${f.p}|${f.b}`;
  if (listCache && listCache.fp === fp) return listCache.payload;
  if (!listLoading || listLoading.fp !== fp) {
    const promise = readProjectList()
      .then((payload) => { listCache = { fp, payload }; return payload; })
      .finally(() => { if (listLoading && listLoading.promise === promise) listLoading = null; });
    listLoading = { fp, promise };
  }
  return listLoading.promise;
}

// GET /api/projects — list all projects, each with its full BOM embedded
router.get('/', async (req, res) => {
  res.json(await getProjectList());
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
         rec_wood, plan_wood, rec_ext, plan_ext, certifications, docs, job_work_po, drawing_wood, drawing_ext, remarks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        projectId, body.sap, body.type, body.category, body.customer, body.pm, body.eng, body.po || '',
        !!body.hasWood, !!body.hasExt,
        body.recWood || null, body.planWood || null, body.recExt || null, body.planExt || null,
        JSON.stringify(body.certifications || []),
        JSON.stringify(Array.isArray(body.docs) ? body.docs : []),
        body.jobWorkPO || '',
        body.drawingWood || '',
        body.drawingExt || '',
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
          b.boardQty ?? Math.max(1, Math.ceil(b.qty / (b.componentsPerBoard || 8))),
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
        await client.query(
          `UPDATE projects SET has_wood = true, rec_wood = $1, plan_wood = $2,
             drawing_wood = COALESCE(NULLIF($3, ''), drawing_wood)
           WHERE id = $4`,
          [body.received || null, body.tat || null, body.drawing || '', req.params.id]);
      } else {
        // Extrusion — persist job_work_po + drawing alongside the new segment if provided
        await client.query(
          `UPDATE projects SET has_ext = true, rec_ext = $1, plan_ext = $2,
             job_work_po = COALESCE(NULLIF($3, ''), job_work_po),
             drawing_ext = COALESCE(NULLIF($4, ''), drawing_ext)
           WHERE id = $5`,
          [body.received || null, body.tat || null, body.jobWorkPO || '', body.drawing || '', req.params.id]);
      }
    } else {
      // Segment already exists — still allow PO / drawing to be updated on re-save
      if (segment === 'ext' && body.jobWorkPO) {
        await client.query('UPDATE projects SET job_work_po = $1 WHERE id = $2',
          [body.jobWorkPO, req.params.id]);
      }
      if (body.drawing) {
        const col = segment === 'wood' ? 'drawing_wood' : 'drawing_ext';
        await client.query(`UPDATE projects SET ${col} = $1 WHERE id = $2`, [body.drawing, req.params.id]);
      }
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
          b.boardQty ?? Math.max(1, Math.ceil(b.qty / (b.componentsPerBoard || 8))),
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
  // v54.5 — Extended PATCH: accepts full header field list. UI gates the
  // wider field set (customer/pm/eng/type/etc.) on superadmin; endpoint
  // itself remains open to admin+ so existing Remarks + PO save flows
  // continue to work exactly as before.
  const body = req.body || {};

  const COL = {
    sap: 'sap', type: 'type', category: 'category', customer: 'customer',
    pm: 'pm', eng: 'eng', po: 'po', jobWorkPO: 'job_work_po', remarks: 'remarks',
    drawingWood: 'drawing_wood', drawingExt: 'drawing_ext',
    recWood: 'rec_wood', planWood: 'plan_wood', recExt: 'rec_ext', planExt: 'plan_ext',
    dlyWood: 'dly_wood', dlyExt: 'dly_ext',
    certifications: 'certifications',
  };

  const incoming = Object.keys(COL).filter(k => body[k] !== undefined);
  if (!incoming.length) return res.status(400).json({ error: 'No updatable fields provided' });

  const cur = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'Project not found' });
  const before = cur.rows[0];

  const updates = [];
  const values = [];
  const changed = [];
  let i = 1;
  for (const key of incoming) {
    const col = COL[key];
    let newVal = body[key];
    if (col === 'certifications') newVal = JSON.stringify(newVal || []);
    else if (newVal === null) newVal = null;
    else newVal = String(newVal);

    const oldRaw = before[col];
    const oldStr = (oldRaw === null || oldRaw === undefined)
      ? null
      : (col === 'certifications' ? JSON.stringify(oldRaw) : String(oldRaw));
    if (oldStr === newVal) continue;

    updates.push(`${col} = $${i++}`);
    values.push(newVal);
    changed.push({ field: key, oldVal: oldStr, newVal });
  }

  if (!updates.length) {
    return res.json({ ok: true, project: { id: before.id }, changed: [] });
  }

  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE projects SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, remarks, job_work_po`,
    values
  );

  const userId = (req.user && req.user.id) ? req.user.id : null;
  for (const ch of changed) {
    try {
      await pool.query(
        'INSERT INTO project_edit_log (user_id, project_id, field, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
        [userId, req.params.id, ch.field, ch.oldVal, ch.newVal]
      );
    } catch (err) {
      console.error('[project_edit_log] insert failed for field', ch.field, err.message);
    }
  }

  const row = result.rows[0];
  res.json({
    ok: true,
    project: { id: row.id, remarks: row.remarks, jobWorkPO: row.job_work_po },
    changed: changed.map(c => c.field),
  });
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