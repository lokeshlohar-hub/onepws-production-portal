const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function rowToTodo(row) {
  return {
    id: row.id,
    task: row.task,
    assignedTo: row.assigned_to,
    department: row.department,
    remarks: row.remarks,
    status: row.status,
    dueDate: row.due_date,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedBy: row.completed_by,
    completedAt: row.completed_at,
    history: row.history || [],
  };
}

// GET /api/todo-list — full list, most recently created first
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM todo_list ORDER BY created_at DESC');
  res.json({ todos: rows.map(rowToTodo) });
});

// POST /api/todo-list — create a new task
router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.task) return res.status(400).json({ error: 'task is required' });
  const id = 'TD-' + String(Date.now()).slice(-8);
  const history = [{ ts: new Date().toISOString(), user: b.createdBy || 'Unknown', action: 'Created' }];
  const { rows } = await pool.query(
    `INSERT INTO todo_list (id, task, assigned_to, department, remarks, status, due_date, created_by, history)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, b.task, b.assignedTo || '', b.department || '', b.remarks || '',
     b.status || 'Pending', b.dueDate || null, b.createdBy || 'Unknown', JSON.stringify(history)]
  );
  res.status(201).json({ todo: rowToTodo(rows[0]) });
});

// PUT /api/todo-list/:id — update a task (details, status, or mark complete)
router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM todo_list WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Task not found' });
  const existing = existingRows[0];
  const history = existing.history || [];
  const actor = b.updatedBy || 'Unknown';

  const newStatus = b.status || existing.status;
  if (newStatus !== existing.status) {
    history.push({ ts: new Date().toISOString(), user: actor, action: 'Status changed', from: existing.status, to: newStatus });
  }
  if (b.remarks !== undefined && b.remarks !== existing.remarks) {
    history.push({ ts: new Date().toISOString(), user: actor, action: 'Remarks updated' });
  }

  const isCompleting = newStatus === 'Completed' && existing.status !== 'Completed';
  const completedBy = isCompleting ? actor : existing.completed_by;
  const completedAt = isCompleting ? new Date().toISOString() : existing.completed_at;

  const { rows } = await pool.query(
    `UPDATE todo_list SET task=$1, assigned_to=$2, department=$3, remarks=$4, status=$5, due_date=$6,
       completed_by=$7, completed_at=$8, history=$9
     WHERE id=$10 RETURNING *`,
    [
      b.task ?? existing.task, b.assignedTo ?? existing.assigned_to, b.department ?? existing.department,
      b.remarks ?? existing.remarks, newStatus, b.dueDate ?? existing.due_date,
      completedBy, completedAt, JSON.stringify(history), req.params.id,
    ]
  );
  res.json({ todo: rowToTodo(rows[0]) });
});

// DELETE /api/todo-list/:id
router.delete('/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM todo_list WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Task not found' });
  res.json({ ok: true, id: rows[0].id });
});

module.exports = router;
