const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/admin-config — every stored key at once, as {key: value, key2: value2, ...}
// so the frontend can merge it straight into its M object on login.
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT config_key, config_value FROM admin_config');
  const out = {};
  rows.forEach(r => { out[r.config_key] = r.config_value; });
  res.json({ config: out });
});

// PUT /api/admin-config/:key — upsert one key's full value. The frontend always
// sends the complete current array/object for that key (not a delta), since
// these are small admin-managed lists, not high-volume records — this keeps
// every existing add/edit/delete function's logic completely untouched; each
// one just calls this once at the end with whatever M[key] now looks like.
router.put('/:key', requireRole('admin', 'superadmin'), async (req, res) => {
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value is required' });
  const { rows } = await pool.query(
    `INSERT INTO admin_config (config_key, config_value, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (config_key) DO UPDATE SET config_value=$2, updated_at=now(), updated_by=$3
     RETURNING config_key, config_value`,
    [req.params.key, JSON.stringify(value), (req.user && req.user.username) || 'Admin']
  );
  res.json({ key: rows[0].config_key, value: rows[0].config_value });
});

module.exports = router;
