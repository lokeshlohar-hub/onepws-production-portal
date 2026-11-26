const { Pool } = require('pg');

// Render provides DATABASE_URL automatically when you attach a Postgres
// instance to a Web Service. Locally, set it in your .env file instead
// (see .env.example).
// Office database (2026-11): when PORTAL_DB_TUNNEL_HOST is set, the portal uses the office PostgreSQL through the
// Cloudflare tunnel (docker-start.sh) at OFFICE_DATABASE_URL (127.0.0.1:15432 inside the container; the tunnel itself
// is encrypted, so no SSL on this leg). DATABASE_URL (Supabase) stays configured untouched, so switching back is just
// removing PORTAL_DB_TUNNEL_HOST. See office-db/README.txt.
const viaOffice = !!process.env.PORTAL_DB_TUNNEL_HOST;
const connectionString = viaOffice ? process.env.OFFICE_DATABASE_URL : process.env.DATABASE_URL;

if (!connectionString) {
  console.error(viaOffice
    ? 'PORTAL_DB_TUNNEL_HOST is set but OFFICE_DATABASE_URL is missing. See office-db/README.txt.'
    : 'Missing DATABASE_URL environment variable. See .env.example.');
  process.exit(1);
}

// Render's internal database URLs don't require SSL; its EXTERNAL urls do.
// This flag lets both work without editing code when you move from local -> Render.
const useSSL = !viaOffice && process.env.PGSSL !== 'false';

const pool = new Pool({
  connectionString,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  // A request that cannot get a connection fails after 15 s instead of hanging (e.g. the office tunnel is down).
  connectionTimeoutMillis: 15000,
  keepAlive: true,
});

// An idle connection that drops (Supabase pooler restart, office tunnel reconnect) must not crash the server:
// the pool discards it and opens a new one on the next query.
pool.on('error', (err) => {
  console.error('[db] idle connection error (discarded):', err && err.message);
});

module.exports = { pool, dbLocation: viaOffice ? 'office' : 'cloud' };
