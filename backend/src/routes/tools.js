const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function rowToTool(row) {
  return {
    id: row.id,
    toolCode: row.tool_code,
    name: row.name,
    category: row.category,
    compatibleMachine: row.compatible_machine,
    specification: row.specification,
    qtyAvailable: row.qty_available,
    minStock: row.min_stock,
    supplier: row.supplier,
    purchaseDate: row.purchase_date ? row.purchase_date.toISOString().split('T')[0] : null,
    cost: row.cost == null ? 0 : Number(row.cost),
    status: row.status,
    remarks: row.remarks,
  };
}
function rowToIssue(row) {
  return {
    id: row.id,
    toolId: row.tool_id,
    toolName: row.tool_name,
    qtyIssued: row.qty_issued,
    machine: row.machine,
    operator: row.operator,
    projectId: row.project_id,
    projectSap: row.project_sap,
    issueDate: row.issue_date ? row.issue_date.toISOString().split('T')[0] : null,
    issueLocation: row.issue_location,
    status: row.status,
    componentsProcessed: row.components_processed,
    productionHoursUsed: row.production_hours_used == null ? null : Number(row.production_hours_used),
    discardDate: row.discard_date ? row.discard_date.toISOString().split('T')[0] : null,
    discardReason: row.discard_reason,
    totalUsageDays: row.total_usage_days,
    enteredBy: row.entered_by,
    ts: row.ts,
  };
}

// GET /api/tool-inventory — tool master + full issue log together
router.get('/', async (req, res) => {
  const tools = await pool.query('SELECT * FROM tool_inventory ORDER BY tool_code');
  const issues = await pool.query('SELECT * FROM tool_issue_log ORDER BY ts DESC');
  res.json({ tools: tools.rows.map(rowToTool), issueLog: issues.rows.map(rowToIssue) });
});

// POST /api/tool-inventory — add a new tool to the master
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const b = req.body || {};
  if (!b.toolCode || !b.name) return res.status(400).json({ error: 'toolCode and name are required' });
  const id = 'TL-' + String(Date.now()).slice(-8);
  const { rows } = await pool.query(
    `INSERT INTO tool_inventory
      (id, tool_code, name, category, compatible_machine, specification, qty_available, min_stock,
       supplier, purchase_date, cost, status, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id, b.toolCode, b.name, b.category || null, b.compatibleMachine || null, b.specification || '',
     b.qtyAvailable || 0, b.minStock || 0, b.supplier || '', b.purchaseDate || null, b.cost || 0,
     b.status || 'Active', b.remarks || '']
  );
  res.json({ tool: rowToTool(rows[0]) });
});

// PUT /api/tool-inventory/:id — update a tool (stock level, status, etc.)
router.put('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM tool_inventory WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Tool not found' });
  const existing = rowToTool(existingRows[0]);
  const merged = { ...existing, ...b };
  const { rows } = await pool.query(
    `UPDATE tool_inventory SET
       tool_code=$1, name=$2, category=$3, compatible_machine=$4, specification=$5, qty_available=$6,
       min_stock=$7, supplier=$8, purchase_date=$9, cost=$10, status=$11, remarks=$12, updated_at=now()
     WHERE id=$13 RETURNING *`,
    [merged.toolCode, merged.name, merged.category, merged.compatibleMachine, merged.specification,
     merged.qtyAvailable, merged.minStock, merged.supplier, merged.purchaseDate, merged.cost,
     merged.status, merged.remarks, req.params.id]
  );
  res.json({ tool: rowToTool(rows[0]) });
});

// POST /api/tool-inventory/bulk — CSV bulk import
router.post('/bulk', requireRole('admin', 'superadmin'), async (req, res) => {
  const list = (req.body || {}).tools;
  if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'tools array is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const b of list) {
      if (!b.toolCode || !b.name) continue;
      const id = 'TL-' + String(Date.now()).slice(-8) + Math.floor(Math.random() * 100);
      const { rows } = await client.query(
        `INSERT INTO tool_inventory
          (id, tool_code, name, category, compatible_machine, specification, qty_available, min_stock,
           supplier, purchase_date, cost, status, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, b.toolCode, b.name, b.category || null, b.compatibleMachine || null, b.specification || '',
         b.qtyAvailable || 0, b.minStock || 0, b.supplier || '', b.purchaseDate || null, b.cost || 0,
         b.status || 'Active', b.remarks || '']
      );
      created.push(rowToTool(rows[0]));
    }
    await client.query('COMMIT');
    res.json({ tools: created });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Bulk import failed', detail: err.message });
  } finally {
    client.release();
  }
});

// POST /api/tool-inventory/issue — issue stock to production, decrementing
// the tool's available quantity in the same transaction
router.post('/issue', requireRole('admin', 'superadmin'), async (req, res) => {
  const b = req.body || {};
  if (!b.toolId || !b.qtyIssued) return res.status(400).json({ error: 'toolId and qtyIssued are required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: toolRows } = await client.query('SELECT * FROM tool_inventory WHERE id = $1 FOR UPDATE', [b.toolId]);
    if (!toolRows[0]) throw new Error('Tool not found');
    const tool = toolRows[0];
    if (tool.qty_available < b.qtyIssued) throw new Error('Not enough stock available');
    const id = 'TI-' + String(Date.now()).slice(-8);
    const { rows: issueRows } = await client.query(
      `INSERT INTO tool_issue_log
        (id, tool_id, tool_name, qty_issued, machine, operator, project_id, project_sap,
         issue_date, issue_location, status, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, b.toolId, tool.name, b.qtyIssued, b.machine || null, b.operator || null,
       b.projectId || null, b.projectSap || null, b.issueDate || null, b.issueLocation || '',
       'Active', b.enteredBy || 'Admin User']
    );
    const { rows: updatedToolRows } = await client.query(
      'UPDATE tool_inventory SET qty_available = qty_available - $1, updated_at = now() WHERE id = $2 RETURNING *',
      [b.qtyIssued, b.toolId]
    );
    await client.query('COMMIT');
    res.json({ issue: rowToIssue(issueRows[0]), tool: rowToTool(updatedToolRows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: 'Could not issue tool', detail: err.message });
  } finally {
    client.release();
  }
});

// PUT /api/tool-inventory/issue/:id — update an issue record (return / discard tracking)
router.put('/issue/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const b = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM tool_issue_log WHERE id = $1', [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: 'Issue record not found' });
  const existing = rowToIssue(existingRows[0]);
  const merged = { ...existing, ...b };
  const { rows } = await pool.query(
    `UPDATE tool_issue_log SET
       status=$1, components_processed=$2, production_hours_used=$3, discard_date=$4,
       discard_reason=$5, total_usage_days=$6
     WHERE id=$7 RETURNING *`,
    [merged.status, merged.componentsProcessed, merged.productionHoursUsed, merged.discardDate,
     merged.discardReason, merged.totalUsageDays, req.params.id]
  );
  res.json({ issue: rowToIssue(rows[0]) });
});

module.exports = router;
