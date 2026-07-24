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

  if (isBoardStage(stageName)) {
    if (idx <= 0) return line.board_qty || 1;
    const prevStage = line.route[idx - 1];
    if (isBoardStage(prevStage)) return (line.stage_data[prevStage] || {}).qc_approved || 0;
    return line.board_qty || 1;
  }
  if (idx <= 0) return line.components_released || line.original_qty || line.qty;
  const prevStage = line.route[idx - 1];
  const prevData = line.stage_data[prevStage] || {};
  if (isSawStage(prevStage)) return line.components_released || 0;
  return prevData.qc_approved || 0;
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
  return { completed: 0, qc_queue: 0, qc_approved: 0, qc_rejected: 0, rework: 0, scrap: 0, history: [] };
}

// mirrors ensureBomLineStructure() defaults — used whenever a line comes back
// from the DB missing a field that older rows might not have (schema evolves,
// same as the frontend's backward-compatible defaulting pattern).
function withDefaults(line) {
  line.stage_data = line.stage_data || {};
  (line.route || []).forEach((st) => {
    if (!line.stage_data[st]) line.stage_data[st] = emptyStageData();
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
      boardQty, JSON.stringify(route), JSON.stringify(stageData),
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
async function refreshProjectProgress(client, projectId) {
  const { rows } = await client.query('SELECT * FROM bom_lines WHERE project_id = $1', [projectId]);
  let totalQty = 0, totalDone = 0;
  rows.forEach((row) => {
    const line = withDefaults({ ...row, stage_data: row.stage_data, route: row.route });
    const lastStage = line.route[line.route.length - 1];
    totalQty += line.qty;
    totalDone += lastStage ? (line.stage_data[lastStage] || {}).qc_approved || 0 : 0;
  });
  const progress = totalQty > 0 ? Math.round((totalDone / totalQty) * 100) : 0;
  await client.query('UPDATE projects SET progress = $1 WHERE id = $2', [progress, projectId]);
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
    const sd = line.stage_data[stageName];
    if (!sd) throw new Error(`Stage "${stageName}" is not on this line's route`);

    const projRes = await client.query('SELECT sap FROM projects WHERE id = $1', [line.project_id]);
    const projSap = projRes.rows[0] ? projRes.rows[0].sap : line.project_id;

    sd.qc_queue -= approveQty + rejectQty;
    sd.qc_approved += approveQty;

    if (isSawStage(stageName) && approveQty > 0) {
      applyBoardToComponentConversion(line, stageName, approveQty);
    }

    let reworkLine = null;
    const instrumentLabel = instrument ? `${instrument.tagNo} — ${instrument.name}` : null;

    if (rejectQty > 0) {
      sd.qc_rejected += rejectQty;
      if (disposition === 'rework') {
        sd.rework += rejectQty;
        reworkLine = await spawnReworkBomLine(client, line, rejectQty, stageName, category, remarks);
        line.qty = Math.max(0, line.qty - rejectQty);
      } else {
        sd.scrap += rejectQty;
      }

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
async function submitStageEntry(lineId, { stageName, qty, operator, shift, remark }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM bom_lines WHERE line_id = $1 FOR UPDATE', [lineId]);
    if (!rows.length) throw new Error('BOM line not found');
    const line = withDefaults(rows[0]);
    const sd = line.stage_data[stageName];
    if (!sd) throw new Error(`Stage "${stageName}" is not on this line's route`);

    const available = pendingQty(line, stageName);
    if (qty <= 0 || qty > available) throw new Error(`Invalid quantity — ${available} available at this stage`);

    sd.completed += qty;
    sd.qc_queue += qty;
    sd.history.push({
      ts: new Date().toISOString(),
      ws: stageName,
      operator,
      shift,
      qty,
      action: `${qty} completed and sent to QC${remark ? ' | ' + remark : ''}`,
    });

    await client.query('UPDATE bom_lines SET stage_data = $1 WHERE line_id = $2', [JSON.stringify(line.stage_data), lineId]);
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
