const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();
router.use(requireAuth);

async function nextTovId(client) {
  const { rows } = await client.query("SELECT nextval('tov_id_seq') AS n");
  return 'TOV-' + String(rows[0].n).padStart(5, '0');
}

router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM tat_overrides ORDER BY created_at');
    res.json({ overrides: rows });
  } catch (err) {
    res.status(500).json({ error: 'Could not load timeline overrides', detail: err.message });
  }
});

router.post('/', async (req, res) => {
  const {
    projectId, segment, originalReceived, originalPlan, overrideReason,
    reasonCategory, revisedStartDate, revisedCompletion, delayDaysAdded,
    responsibilityCategory, notes, createdByName
  } = req.body || {};

  if (!projectId || !segment || !overrideReason || !reasonCategory || !revisedStartDate || !revisedCompletion) {
    return res.status(400).json({ error: 'projectId, segment, overrideReason, reasonCategory, revisedStartDate, and revisedCompletion are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projRows } = await client.query('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (!projRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Project not found' }); }

    const id = await nextTovId(client);
    const { rows } = await client.query(
      `INSERT INTO tat_overrides (
         id, project_id, segment, original_received, original_plan,
         override_reason, reason_category, revised_start_date, revised_completion,
         delay_days_added, responsibility_category, notes, created_by_name, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        id, projectId, segment, originalReceived || null, originalPlan || null,
        overrideReason, reasonCategory, revisedStartDate, revisedCompletion,
        delayDaysAdded || 0, responsibilityCategory || '', notes || '', createdByName || '', req.user.id
      ]
    );

    // If this project (or its 'both' case) already has an actual completion
    // date, recalculate delay right now against the new revised deadline —
    // otherwise a project that finished BEFORE this override was added would
    // keep showing its old, wrong delay number forever, since nothing else
    // will naturally re-trigger a recalculation on an already-completed project.
    const { rows: projStateRows } = await client.query(
      'SELECT has_wood, has_ext, act_wood, act_ext FROM projects WHERE id = $1', [projectId]
    );
    const proj = projStateRows[0] || {};
    if ((segment === 'wood' || segment === 'both') && proj.has_wood && proj.act_wood) {
      await client.query(
        'UPDATE projects SET dly_wood = (act_wood - $1::date) WHERE id = $2',
        [revisedCompletion, projectId]
      );
    }
    if ((segment === 'ext' || segment === 'both') && proj.has_ext && proj.act_ext) {
      await client.query(
        'UPDATE projects SET dly_ext = (act_ext - $1::date) WHERE id = $2',
        [revisedCompletion, projectId]
      );
    }

    await client.query('COMMIT');
    res.json({ override: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not save timeline override', detail: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;