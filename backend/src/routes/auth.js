const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  if (!user.active) return res.status(403).json({ error: 'This account has been deactivated. Contact your Master Admin.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

  await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);

  const token = signToken(user);
  delete user.password_hash;
  res.json({ token, user });
});

// GET /api/auth/me — returns the logged-in user's current record (fresh
// permissions, in case Master Admin changed them since this token was issued)
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, full_name, role, department, active, permissions FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: rows[0] });
});

// GET /api/users — Master Admin only (Phase 1: superadmin-only, matching the
// frontend's "User & Permission Management is Master Admin only" rule)
router.get('/users', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { rows } = await pool.query('SELECT id, username, full_name, role, department, active, permissions, created_at, last_login FROM users ORDER BY id');
  res.json({ users: rows });
});

// POST /api/users — create a new user (Master Admin only)
router.post('/users', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { username, password, fullName, role, department, permissions } = req.body || {};
  if (!username || !password || !fullName || !role) {
    return res.status(400).json({ error: 'username, password, fullName, and role are required' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, department, permissions)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, username, full_name, role, department, active, permissions`,
      [username, passwordHash, fullName, role, department || null, permissions ? JSON.stringify(permissions) : null]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    throw err;
  }
});

// PUT /api/users/:id — edit a user (Master Admin only)
router.put('/users/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { fullName, role, department, active, permissions, password } = req.body || {};
  const fields = [];
  const values = [];
  let i = 1;
  if (fullName !== undefined) { fields.push(`full_name = $${i++}`); values.push(fullName); }
  if (role !== undefined) { fields.push(`role = $${i++}`); values.push(role); }
  if (department !== undefined) { fields.push(`department = $${i++}`); values.push(department); }
  if (active !== undefined) { fields.push(`active = $${i++}`); values.push(active); }
  if (permissions !== undefined) { fields.push(`permissions = $${i++}`); values.push(JSON.stringify(permissions)); }
  if (password) { fields.push(`password_hash = $${i++}`); values.push(await bcrypt.hash(password, 10)); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, username, full_name, role, department, active, permissions`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: rows[0] });
});

// DELETE /api/users/:id — remove a user account (Master Admin only)
router.delete('/users/:id', requireAuth, requireRole('superadmin'), async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT id, role, active, username FROM users WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'User not found' });
  const target = existingRows[0];
  if (target.role === 'superadmin' && target.active) {
    const { rows: otherActiveSuperadmins } = await pool.query(
      "SELECT id FROM users WHERE role = 'superadmin' AND active = true AND id != $1", [req.params.id]
    );
    if (!otherActiveSuperadmins.length) {
      return res.status(400).json({ error: 'Cannot delete — at least one active Master Admin must remain.' });
    }
  }
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true, deletedId: req.params.id, username: target.username });
});

module.exports = router;
