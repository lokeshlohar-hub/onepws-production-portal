// ============================================================================
// PRODUCTION ENGINE — server-side port of the frontend's BOM/stage/QC logic
// ============================================================================
// This intentionally mirrors the client-side functions in index.html
// (ensureBomLineStructure, eligibleInputQty, pendingQty, processQcDecision,
// spawnReworkBomLine) as closely as possible, so the two stay in sync and so
// this port can be reviewed line-by-line against what's already been tested
// in the browser. Once the frontend is wired up to call this API, the
// server becomes the single source of truth for these calculations.

const { pool } = require('../db');

// Self-healing helper — when a stage submit or QC decision hits a line
// whose stage_data doesn't yet contain the target stage, this checks
// whether the stage exists in the master componentRouting for the line's
// item (admin_config JSONB). If yes, inserts the stage into line.route
// at the correct master-order position and initializes an empty
// stage_data entry, then persists the amended line inside the caller's
// transaction so the submit proceeds normally.
//
// Also normalizes case + whitespace drift: if stage_data has the stage
// under a slightly different key (e.g. "Din Rail Cutter" vs "Din rail
// cutter"), rewrites to the requested spelling so the caller's
// subsequent line.stage_data[stageName] lookup succeeds.
//
// Returns true if the line now has the stage (either it already did,
// case-normalized, or it was newly added). Returns false only when the
// stage isn't in master routing either — genuine "stage doesn't belong
// to this line" case which the caller then errors on.
async function ensureLineHasStage(client, line, stageName) {
  console.log('[healStage] Called for line', line.line_id, 'item="' + line.item + '" stage="' + stageName + '"');
  if (!stageName) { console.log('[healStage] no stageName; returning false'); return false; }
  const norm = String(stageName).trim().toLowerCase();
  // Case-insensitive scan of existing stage_data first — most common
  // healing scenario (canonicalization drift).
  console.log('[healStage] Existing stage_data keys:', Object.keys(line.stage_data));
  const existingKey = Object.keys(line.stage_data).find(
    k => String(k).trim().toLowerCase() === norm
  );
  if (existingKey) {
    console.log('[healStage] Found existing key by case-insensitive match:', existingKey);
    if (existingKey !== stageName) {
      // Rewrite under the requested spelling; preserve counters/history
      line.stage_data[stageName] = line.stage_data[existingKey];
      delete line.stage_data[existingKey];
      const routeIdx = line.route.findIndex(
        r => String(r).trim().toLowerCase() === norm
      );
      if (routeIdx >= 0) line.route[routeIdx] = stageName;
      await client.query(
        'UPDATE bom_lines SET route = $1, stage_data = $2 WHERE line_id = $3',
        [JSON.stringify(line.route), JSON.stringify(line.stage_data), line.line_id]
      );
    }
    return true;
  }
  // Not in stage_data — check master routing. Load admin_config's
  // componentRouting for this line's item and see if the stage exists there.
  // Item lookup is case-insensitive: if the config was keyed as "Din Rail"
  // but the BOM line stored the item as "Din rail" (or vice versa), the
  // strict-equality lookup would silently miss and the healing wouldn't
  // fire. So we scan the config keys with a normalized comparison.
  const cfgRes = await client.query(
    "SELECT config_value FROM admin_config WHERE config_key = 'componentRouting'"
  );
  console.log('[healStage] admin_config query returned', cfgRes.rows.length, 'rows');
  if (!cfgRes.rows.length) { console.log('[healStage] No componentRouting row in admin_config; returning false'); return false; }
  const masterRoutings = cfgRes.rows[0].config_value || {};
  console.log('[healStage] Master routing item keys:', Object.keys(masterRoutings));
  const itemNorm = String(line.item || '').trim().toLowerCase();
  const itemKey = Object.keys(masterRoutings).find(
    k => String(k).trim().toLowerCase() === itemNorm
  );
  if (!itemKey) { console.log('[healStage] Item "' + line.item + '" (norm="' + itemNorm + '") not found in masterRoutings; returning false'); return false; }
  console.log('[healStage] Matched item key:', itemKey);
  const masterRoute = masterRoutings[itemKey];
  if (!Array.isArray(masterRoute)) { console.log('[healStage] masterRoute is not an array:', typeof masterRoute); return false; }
  console.log('[healStage] Master route for this item:', masterRoute);
  const masterIdx = masterRoute.findIndex(
    s => String(s).trim().toLowerCase() === norm
  );
  if (masterIdx < 0) { console.log('[healStage] Stage "' + stageName + '" not found in masterRoute; returning false'); return false; }
  console.log('[healStage] Stage found in master at index', masterIdx);
  const canonicalStageName = masterRoute[masterIdx];
  // Find where to insert in line.route: after the previous master-order
  // stage that already exists in line.route. Falls back to appending at
  // end if no earlier master stage is found in the line's snapshot.
  let insertAt = line.route.length;
  for (let i = masterIdx - 1; i >= 0; i--) {
    const prevMaster = masterRoute[i];
    const prevIdx = line.route.findIndex(
      r => String(r).trim().toLowerCase() === String(prevMaster).trim().toLowerCase()
    );
    if (prevIdx >= 0) { insertAt = prevIdx + 1; break; }
  }
  if (masterIdx === 0) insertAt = 0;
  line.route.splice(insertAt, 0, canonicalStageName);
  line.stage_data[canonicalStageName] = {
    completed: 0, qc_queue: 0, qc_approved: 0, qc_rejected: 0,
    rework: 0, scrap: 0, history: [], offered_log: []
  };
  await client.query(
    'UPDATE bom_lines SET route = $1, stage_data = $2 WHERE line_id = $3',
    [JSON.stringify(line.route), JSON.stringify(line.stage_data), line.line_id]
  );
  // If the caller passed a name with a different casing from master, honor
  // caller's spelling by aliasing (both keys point to the same object).
  if (canonicalStageName !== stageName) {
    line.stage_data[stageName] = line.stage_data[canonicalStageName];
  }
  return true;
}

// Stages that work in "boards" rather than individual components before the
// board->component conversion happens. Hardcoded for Phase 1 since the
// admin-configurable stage-type system (M.stageConfig) still lives only on
// the frontend and hasn't been migrated to the database yet.
function isSawStage(stageName) {
  return /beam saw/i.test(stageName || '');
}
function isBoardStage(stageName) {
  return /hot press/i.test(stageName || '') || isSawStage(stageName);
}

// Quantity eligible to be worked on at a given stage — mirrors eligibleInputQty()
function eligibleInputQty(line, stageName) {
  const idx = line.route.indexOf(stageName);
  if (idx < 0) return 0;
  // Defensive numeric coercion — some columns can come back as strings from
  // pg depending on the type (e.g. NUMERIC → string). A string "0" is truthy
  // in JS and would short-circuit the || chain incorrectly. Coerce first.
  const compRel = Number(line.components_released) || 0;
  const origQty = Number(line.original_qty) || 0;
  const qty = Number(line.qty) || 0;

  if (isBoardStage(stageName) && !line.is_rework) {   // v54.3 - RP lines are component-count
    const boardQty = Number(line.board_qty) || 1;
    if (idx <= 0) return boardQty;
    const prevStage = line.route[idx - 1];
    if (isBoardStage(prevStage)) return Number((line.stage_data[prevStage] || {}).qc_approved) || 0;
    return boardQty;
  }
  if (idx <= 0) return compRel || origQty || qty;
  const prevStage = line.route[idx - 1];
  const prevData = line.stage_data[prevStage] || {};
  if (isSawStage(prevStage)) return compRel;
  return Number(prevData.qc_approved) || 0;
}

// mirrors pendingQty()
function pendingQty(line, stageName) {
  const sd = line.stage_data[stageName] || {};
  return Math.max(0, eligibleInputQty(line, stageName) - (sd.completed || 0));
}

// mirrors isComponentComplete()
function isComponentComplete(line) {
  const lastStage = line.route[line.route.length - 1];
  if (!lastStage) return false;
  const sd = line.stage_data[lastStage] || {};
  return (sd.qc_approved || 0) >= line.qty;
}

function emptyStageData() {
  return { completed: 0, qc_queue: 0, qc_approved: 0, qc_rejected: 0, rework: 0, scrap: 0, history: [], offered_log: [] };
}

// mirrors ensureBomLineStructure() defaults — used whenever a line comes back
// from the DB missing a field that older rows might not have (schema evolves,
// same as the frontend's backward-compatible defaulting pattern).
function withDefaults(line) {
  line.stage_data = line.stage_data || {};
  (line.route || []).forEach((st) => {
    if (!line.stage_data[st]) line.stage_data[st] = emptyStageData();
  });
  // Backward-compat: rows written before Offered Date tracking existed have
  // stage entries with no offered_log — default it so reads/writes are safe.
  Object.keys(line.stage_data).forEach((st) => {
    if (!Array.isArray(line.stage_data[st].offered_log)) line.stage_data[st].offered_log = [];
  });
  if (line.original_qty == null) line.original_qty = line.qty;
  if (line.components_released == null) line.components_released = 0;
  if (line.special_chars == null) line.special_chars = [];
  return line;
}

// mirrors applyBoardToComponentConversion()
function applyBoardToComponentConversion(line, sawStageName, boardsApproved) {
  const boardQty = line.board_qty || 1;
  const compQty = line.qty || 1;
  const ratio = compQty / boardQty;
  const newComponents = Math.round(boardsApproved * ratio);
  line.components_released = (line.components_released || 0) + newComponents;
  line.stage_data[sawStageName].history.push({
    ts: new Date().toISOString(),
    ws: 'CONVERSION',
    operator: 'Auto',
    qty: boardsApproved,
    action: `Conversion: ${boardsApproved} boards approved → ${newComponents} components released for downstream (ratio ${ratio.toFixed(2)})`,
  });
}

async function nextBomLineId(client) {
  const { rows } = await client.query("SELECT nextval('bom_line_id_seq') AS n");
  return 'BL-' + String(rows[0].n).padStart(5, '0');
}
async function nextProjectId(client) {
  const { rows } = await client.query("SELECT nextval('project_id_seq') AS n");
  return 'PRJ-' + String(rows[0].n).padStart(4, '0');
}

// mirrors spawnReworkBomLine() — creates a brand-new BOM line for the
// rejected quantity, with its OWN fresh route/stage_data starting at the
// first stage, carrying a back-reference to the line that spawned it.
async function spawnReworkBomLine(client, origLine, rejectQty, stageName, category, remarks) {
  const lineId = await nextBomLineId(client);
  const route = origLine.route.slice(); // same routing sequence as the original component
  const stageData = {};
  route.forEach((st) => { stageData[st] = emptyStageData(); });

  const boardQty = origLine.components_per_board
    ? Math.max(1, Math.ceil(rejectQty / origLine.components_per_board))
    : Math.max(1, Math.ceil(rejectQty / 8));

  const reworkReason = (category ? category + ' — ' : '') + (remarks || 'No remarks recorded');

  await client.query(
    `INSERT INTO bom_lines (
       line_id, project_id, item, seg, l, w, t, profile, uom, qty, original_qty,
       color_finish, special_chars, components_per_board, edge_meters_per_comp,
       board_qty, components_released, route, stage_data,
       is_rework, rework_of_line_id, rework_source_stage, rework_reason, rework_date, rework_generation
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17,$18,true,$19,$20,$21,CURRENT_DATE,$22)`,
    [
      lineId, origLine.project_id, origLine.item, origLine.seg,
      origLine.l, origLine.w, origLine.t, origLine.profile, origLine.uom,
      rejectQty, rejectQty,
      origLine.color_finish, JSON.stringify(origLine.special_chars || []),
      origLine.components_per_board, origLine.edge_meters_per_comp,
      null, JSON.stringify(route), JSON.stringify(stageData),  // v54.3 - RP lines don't consume board capacity
      origLine.line_id, stageName, reworkReason, (origLine.rework_generation || 0) + 1,
    ]
  );

  const spawned = origLine.spawned_rework_line_ids || [];
  spawned.push(lineId);
  await client.query('UPDATE bom_lines SET spawned_rework_line_ids = $1 WHERE line_id = $2', [
    JSON.stringify(spawned), origLine.line_id,
  ]);

  return { line_id: lineId, item: origLine.item, qty: rejectQty, route };
}

// Recomputes a project's overall progress % by summing qty/last-stage-approved
// across EVERY BOM line belonging to it (original lines + any rework spinoffs)
// — mirrors refreshProjectProgress().
// Returns the latest active Timeline Override's revised completion date for
// a project segment, or null if none exists — mirrors effectivePlanDate()
// on the frontend exactly, so both sides agree on what "the deadline" means.
async function getEffectivePlanDate(client, projectId, segment, fallbackPlanDate) {
  const { rows } = await client.query(
    `SELECT revised_completion FROM tat_overrides
     WHERE project_id = $1 AND (segment = $2 OR segment = 'both')
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, segment]
  );
  return rows[0] ? rows[0].revised_completion : fallbackPlanDate;
}

async function refreshProjectProgress(client, projectId) {
  const { rows } = await client.query('SELECT * FROM bom_lines WHERE project_id = $1', [projectId]);
  let totalQty = 0, totalDone = 0;
  let woodQty = 0, woodDone = 0, extQty = 0, extDone = 0;
  rows.forEach((row) => {
    const line = withDefaults({ ...row, stage_data: row.stage_data, route: row.route });
    const lastStage = line.route[line.route.length - 1];
    const done = lastStage ? (line.stage_data[lastStage] || {}).qc_approved || 0 : 0;
    totalQty += line.qty;
    totalDone += done;
    if (line.seg === 'wood') { woodQty += line.qty; woodDone += done; }
    else if (line.seg === 'ext') { extQty += line.qty; extDone += done; }
  });
  const progress = totalQty > 0 ? Math.round((totalDone / totalQty) * 100) : 0;
  await client.query('UPDATE projects SET progress = $1 WHERE id = $2', [progress, projectId]);

  // Segment-independent completion stamping (v54.6) -- a segment stamps its own
  // act_wood/act_ext the moment ITS OWN progress hits 100%, instead of waiting
  // for the combined total across both segments. Matches the frontend fix in
  // refreshProjectProgress() (index.html) -- this backend copy is the real
  // source of truth for live QC-approval events and was missed in that fix.
  const woodProgress = woodQty > 0 ? Math.round((woodDone / woodQty) * 100) : 0;
  const extProgress  = extQty  > 0 ? Math.round((extDone  / extQty ) * 100) : 0;
  if (woodProgress >= 100 || extProgress >= 100) {
    const { rows: pRows } = await client.query('SELECT has_wood, has_ext, plan_wood, plan_ext, act_wood, act_ext FROM projects WHERE id = $1', [projectId]);
    const proj = pRows[0] || {};
    const effWood = (proj.has_wood && woodProgress >= 100) ? await getEffectivePlanDate(client, projectId, 'wood', proj.plan_wood) : null;
    const effExt  = (proj.has_ext  && extProgress  >= 100) ? await getEffectivePlanDate(client, projectId, 'ext',  proj.plan_ext)  : null;
    await client.query(
      `UPDATE projects SET
         wood_status = CASE WHEN has_wood AND $4 THEN 'Complete' ELSE wood_status END,
         ext_status  = CASE WHEN has_ext  AND $5 THEN 'Complete' ELSE ext_status END,
         act_wood = CASE WHEN has_wood AND $4 AND act_wood IS NULL THEN CURRENT_DATE ELSE act_wood END,
         act_ext  = CASE WHEN has_ext  AND $5 AND act_ext  IS NULL THEN CURRENT_DATE ELSE act_ext END,
         dly_wood = CASE WHEN has_wood AND $4 AND act_wood IS NULL AND $2::date IS NOT NULL THEN (CURRENT_DATE - $2::date) ELSE dly_wood END,
         dly_ext  = CASE WHEN has_ext  AND $5 AND act_ext  IS NULL AND $3::date IS NOT NULL THEN (CURRENT_DATE - $3::date)  ELSE dly_ext  END
       WHERE id = $1`,
      [projectId, effWood, effExt, woodProgress >= 100, extProgress >= 100]
    );
  }
  return progress;
}

// mirrors processQcDecision() — the core rejection/rework engine. Runs inside
// a transaction: reads the line, mutates stage_data exactly like the
// frontend does, spawns a rework line when applicable, writes the reject
// log + stage log entries, and recomputes project progress — all atomically.
async function processQcDecision(lineId, { stageName, approveQty, rejectQty, disposition, category, qcPerson, remarks, instrument, photoData }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM bom_lines WHERE line_id = $1 FOR UPDATE', [lineId]);
    if (!rows.length) throw new Error('BOM line not found');
    const line = withDefaults(rows[0]);
    let sd = line.stage_data[stageName];
    if (!sd) {
      const healed = await ensureLineHasStage(client, line, stageName);
      if (healed) sd = line.stage_data[stageName];
    }
    if (!sd) throw new Error(`Stage "${stageName}" is not on this line's route`);

    const projRes = await client.query('SELECT sap, customer FROM projects WHERE id = $1', [line.project_id]);
    const projSap = projRes.rows[0] ? projRes.rows[0].sap : line.project_id;
    const projCustomer = projRes.rows[0] ? projRes.rows[0].customer : '';

    sd.qc_queue -= approveQty + rejectQty;
    sd.qc_approved += approveQty;

    if (isSawStage(stageName) && approveQty > 0) {
      applyBoardToComponentConversion(line, stageName, approveQty);

      // Persist the shared-board sibling cascade — previously this only ever
      // happened in the browser's memory and was never saved to the database,
      // so sibling lines' released counts silently reverted on every restart.
      // Explicit link (board_source_line_id) is checked first; if a sibling
      // has none set, falls back to the same positional walk the app has
      // always used, so nothing that already works today changes unless
      // someone explicitly picks a parent for that line.
      const { rows: allLines } = await client.query(
        'SELECT * FROM bom_lines WHERE project_id = $1 AND seg = $2 ORDER BY created_at',
        [line.project_id, line.seg]
      );
      const ownerBoardQty = Number(line.board_qty) || 1;
      const idxInSeg = allLines.findIndex(l => l.line_id === line.line_id);

      const linkedChildren = allLines.filter(l =>
        l.line_id !== line.line_id && l.board_source_line_id === line.line_id
      );
      const positionalChildren = [];
      if (idxInSeg >= 0) {
        for (let i = idxInSeg + 1; i < allLines.length; i++) {
          const sib = allLines[i];
          if (sib.board_source_line_id) break;
          if ((Number(sib.board_qty) || 1) !== 0) break;
          positionalChildren.push(sib);
        }
      }
      const siblingsToUpdate = linkedChildren.length ? linkedChildren : positionalChildren;

      for (const sib of siblingsToUpdate) {
        const sibCompQty = Number(sib.qty) || 1;
        const cascadeQty = approveQty >= ownerBoardQty
          ? sibCompQty
          : Math.floor(sibCompQty * (approveQty / ownerBoardQty));
        if (cascadeQty <= 0) continue;
        const newReleased = (Number(sib.components_released) || 0) + cascadeQty;
        await client.query('UPDATE bom_lines SET components_released = $1 WHERE line_id = $2', [newReleased, sib.line_id]);
      }
    }

    let reworkLine = null;
    const instrumentLabel = instrument ? `${instrument.tagNo} — ${instrument.name}` : null;

    if (rejectQty > 0) {
      // v54.3: any rejection = scrap = spawn replacement (RP) BOM line.
      // Rework as a distinct category was removed by session decision.
      sd.qc_rejected += rejectQty;
      sd.scrap += rejectQty;
      reworkLine = await spawnReworkBomLine(client, line, rejectQty, stageName, category, remarks);
      line.qty = Math.max(0, line.qty - rejectQty);

      await client.query(
        `INSERT INTO reject_log (date, project_id, proj_sap, item, stage, workstation, qty, category,
           disposition, qc_person, qc_instrument, qc_instrument_due_date, root_cause,
           source_line_id, rework_line_id, status, photo_data)
         VALUES (CURRENT_DATE,$1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Closed',$14)`,
        [
          line.project_id, projSap, line.item, stageName, rejectQty, category || 'Uncategorized',
          disposition, qcPerson, instrumentLabel, instrument ? instrument.nextDueDate : null,
          remarks || '', line.line_id, reworkLine ? reworkLine.line_id : null, photoData || null,
        ]
      );
    }

    // v54.8 -- Complete QC History (both Pass and Reject) -- additive, does
    // not touch reject_log or any existing rejection reporting/Pareto logic.
    // Fires exactly once per QC decision, regardless of approve/reject split.
    const qcStatus = rejectQty > 0 && approveQty > 0 ? 'Partial' : (rejectQty > 0 ? 'Reject' : 'Pass');
    await client.query(
      `INSERT INTO qc_log (date, project_id, proj_sap, customer, item, segment, stage, workstation,
         approve_qty, reject_qty, qc_status, category, root_cause, qc_person, qc_instrument, source_line_id)
       VALUES (CURRENT_DATE,$1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        line.project_id, projSap, projCustomer, line.item, line.seg, stageName,
        approveQty, rejectQty, qcStatus, category || null, remarks || null, qcPerson,
        instrumentLabel, line.line_id,
      ]
    );

    sd.history.push({
      ts: new Date().toISOString(),
      ws: 'QC',
      operator: qcPerson,
      qty: approveQty,
      instrument: instrumentLabel,
      action:
        `QC: ${approveQty} approved` +
        (rejectQty > 0
          ? `, ${rejectQty} rejected (${category || '—'}) → ${disposition}` +
            (reworkLine ? ` — new BOM line auto-created (${reworkLine.line_id})` : '')
          : '') +
        (remarks ? ` | ${remarks}` : ''),
    });

    await client.query('UPDATE bom_lines SET qty = $1, stage_data = $2, components_released = $3 WHERE line_id = $4', [
      line.qty, JSON.stringify(line.stage_data), line.components_released, line.line_id,
    ]);

    await client.query(
      `INSERT INTO stage_log (project_id, project_sap, stage, workstation, operator, app_user, remark)
       VALUES ($1,$2,$3,'QC',$4,$4,$5)`,
      [
        line.project_id, projSap, stageName, qcPerson,
        `Component: ${line.item} | QC: ${approveQty} OK` +
          (rejectQty > 0 ? `, ${rejectQty} ${disposition} (${category || '—'})` + (reworkLine ? ' → new rework BOM line auto-created' : '') : ''),
      ]
    );

    const progress = await refreshProjectProgress(client, line.project_id);

    await client.query('COMMIT');
    return { originalLine: line, reworkLine, projectProgress: progress };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Operator submits a completed quantity at a stage — moves it from "pending"
// into "awaiting QC" (qc_queue). Mirrors the frontend's submitStageEntry().
async function submitStageEntry(lineId, { stageName, qty, operator, shift, remark, assBatchNos, adhesiveBatchNo, adhesiveExpiryDate, chosenWsId, wsLabel, roomTemperature, materialFinish, date }) {
  console.log('[submitStageEntry] v2-healing lineId=' + lineId + ' stage="' + stageName + '" qty=' + qty);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bom_lines WHERE line_id = $1 FOR UPDATE', [lineId]);
    if (!rows.length) throw new Error('BOM line not found');
    const line = withDefaults(rows[0]);
    let sd = line.stage_data[stageName];
    if (!sd) {
      const healed = await ensureLineHasStage(client, line, stageName);
      if (healed) sd = line.stage_data[stageName];
    }
    if (!sd) throw new Error(`Stage "${stageName}" is not on this line's route`);

    const available = pendingQty(line, stageName);
    if (qty <= 0 || qty > available) throw new Error(`Invalid quantity — ${available} available at this stage`);

    sd.completed += qty;
    sd.qc_queue += qty;
    // Offered Date tracking (additive, append-only). Records when completed
    // material was offered to QC at this stage. Uses the production date the
    // user picked in the entry form (so back-dated entries show the real
    // offer date); falls back to today only if no valid date was sent.
    // Never mutated or removed; a re-offer after rejection/rework appends a
    // NEW entry so the original offer history is preserved. Read only by the
    // QC queue display — no approval / rejection / rework / routing logic
    // consumes this.
    if (!Array.isArray(sd.offered_log)) sd.offered_log = [];
    const offeredTs = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date))
      ? date.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    sd.offered_log.push({ ts: offeredTs, qty });
    const historyEntry = {
      ts: new Date().toISOString(),
      ws: stageName,
      operator,
      shift,
      qty,
      action: `${qty} completed and sent to QC${remark ? ' | ' + remark : ''}`,
    };
    // Optional, stage-specific traceability fields — only attached to the
    // history entry when actually provided, so stages that don't use them
    // (which is most stages) keep exactly the same history shape as before.
    if (Array.isArray(assBatchNos) && assBatchNos.length) historyEntry.assBatchNos = assBatchNos;
    if (adhesiveBatchNo) historyEntry.adhesiveBatchNo = adhesiveBatchNo;
    if (adhesiveExpiryDate) historyEntry.adhesiveExpiryDate = adhesiveExpiryDate;
    sd.history.push(historyEntry);

    await client.query('UPDATE bom_lines SET stage_data = $1 WHERE line_id = $2', [JSON.stringify(line.stage_data), lineId]);

    // v54.6 - persist production completion to stage_log so Capacity Planning aggregation
    // sees completed qty attributed to the actual machine. Previously only processQcDecision
    // wrote here (hardcoded 'QC'), so no production entries counted toward capacity.
    try {
      const projRow = await client.query('SELECT id, sap FROM projects WHERE id = $1', [line.project_id]);
      const projSap = projRow.rows[0] ? projRow.rows[0].sap : '';
      const ws = wsLabel || stageName || '';
      const remarkText = 'Component: ' + line.item + ' | Completed ' + qty + (remark ? ' | ' + remark : '');
      await client.query(
        `INSERT INTO stage_log (project_id, project_sap, stage, workstation, operator, app_user, remark)
         VALUES ($1,$2,$3,$4,$5,$5,$6)`,
        [line.project_id, projSap, stageName, ws, operator || '', remarkText]
      );
    } catch (logErr) {
      console.error('[submitStageEntry] stage_log insert failed:', logErr.message);
      // best-effort — do not throw; production entry is already persisted
    }

    await client.query('COMMIT');
    return { line };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  isSawStage, isBoardStage, eligibleInputQty, pendingQty, isComponentComplete,
  withDefaults, nextBomLineId, nextProjectId, refreshProjectProgress,
  processQcDecision, submitStageEntry, spawnReworkBomLine,
};
