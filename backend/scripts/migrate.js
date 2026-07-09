// Applies src/migrations/001_init.sql against DATABASE_URL.
// Run with: npm run migrate
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/migrations/001_init.sql'), 'utf8');
  console.log('Applying migration...');
  await pool.query(sql);
  console.log('Migration applied successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
