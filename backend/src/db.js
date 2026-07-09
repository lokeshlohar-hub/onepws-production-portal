const { Pool } = require('pg');

// Render provides DATABASE_URL automatically when you attach a Postgres
// instance to a Web Service. Locally, set it in your .env file instead
// (see .env.example).
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Missing DATABASE_URL environment variable. See .env.example.');
  process.exit(1);
}

// Render's internal database URLs don't require SSL; its EXTERNAL urls do.
// This flag lets both work without editing code when you move from local -> Render.
const useSSL = process.env.PGSSL !== 'false';

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
