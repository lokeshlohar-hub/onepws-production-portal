// Seeds the same demo accounts the frontend currently ships with, plus one
// sample project with a couple of BOM lines, so there's something to log in
// to and test against immediately. Run with: npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const engine = require('../src/lib/productionEngine');

// Same default permission shapes as the frontend's defaultPermsForRole(), kept
// intentionally simple here — Master Admin bypasses this entirely either way.
function fullPerm() {
  return { view: true, create: true, edit: true, delete: true, approve: true, export: true, print: true, download: true };
}
function viewOnly() {
  return { view: true };
}

const USERS = [
  { username: 'admin', password: 'admin123', fullName: 'Admin User', role: 'superadmin', department: null, permissions: null },
  { username: 'prod.admin', password: 'prod123', fullName: 'Ramesh Kumar', role: 'admin', department: 'Production',
    permissions: { tracker: {view:true,create:true,edit:true,export:true,print:true}, newproject: fullPerm(), stageupdate: fullPerm(), dashboard: viewOnly(), quality: {}, maintenance: {} } },
  { username: 'qc.admin', password: 'qc123', fullName: 'Priya Sharma', role: 'admin', department: 'Quality',
    permissions: { quality: fullPerm(), stageupdate: fullPerm(), dashboard: viewOnly(), tracker: viewOnly() } },
  { username: 'maint.admin', password: 'maint123', fullName: 'Vikram Singh', role: 'admin', department: 'Maintenance',
    permissions: { maintenance: fullPerm(), dashboard: viewOnly() } },
  { username: 'viewer', password: 'view123', fullName: 'Guest Viewer', role: 'viewer', department: null,
    permissions: { tracker: viewOnly(), quality: viewOnly(), maintenance: viewOnly(), dashboard: viewOnly() } },
];

async function main() {
  console.log('Seeding users...');
  for (const u of USERS) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, department, permissions)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, passwordHash, u.fullName, u.role, u.department, u.permissions ? JSON.stringify(u.permissions) : null]
    );
  }

  console.log('Seeding a demo project...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query("SELECT id FROM projects WHERE sap = 'CD-25-26-10175'");
    if (existing.rows.length) {
      console.log('Demo project already exists — skipping.');
    } else {
      const projectId = await engine.nextProjectId(client);
      await client.query(
        `INSERT INTO projects (id, sap, type, category, customer, pm, eng, has_wood, has_ext, rec_wood, plan_wood)
         VALUES ($1,'CD-25-26-10175','CD','Cat 1','JPPL Sample Customer','Shyam','Raju',true,false,CURRENT_DATE,CURRENT_DATE + 20)`,
        [projectId]
      );
      const route = ['Hot Press', 'Selco Beam Saw', 'CNC Router', 'Through-Feed Edge Banding', 'Assembly'];
      const stageData = {};
      route.forEach((st) => { stageData[st] = { completed: 0, qc_queue: 0, qc_approved: 0, qc_rejected: 0, rework: 0, scrap: 0, history: [] }; });

      const lineId = await engine.nextBomLineId(client);
      await client.query(
        `INSERT INTO bom_lines (line_id, project_id, item, seg, l, w, t, uom, qty, original_qty,
           components_per_board, board_qty, components_released, route, stage_data)
         VALUES ($1,$2,'Table Top','wood',1200,900,25,'PC',10,10,8,2,0,$3,$4)`,
        [lineId, projectId, JSON.stringify(route), JSON.stringify(stageData)]
      );
      console.log(`Created demo project ${projectId} (CD-25-26-10175) with BOM line ${lineId}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('Seed complete.');
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
