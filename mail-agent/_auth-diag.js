// Temporary diagnostic — not part of the shipped agent, safe to delete after use.
// Tries one SMTP login (host/port/user/pass from env vars set by _auth-diag.ps1)
// and reports success/failure without ever writing the password to disk.
const nodemailer = require('nodemailer');

const t = nodemailer.createTransport({
  host: process.env.DIAG_HOST,
  port: Number(process.env.DIAG_PORT),
  secure: false,
  auth: { user: process.env.DIAG_USER, pass: process.env.DIAG_PASS },
  tls: { rejectUnauthorized: false },
  connectionTimeout: 8000,
});

t.verify()
  .then(() => console.log('  -> SUCCESS as "' + process.env.DIAG_USER + '"'))
  .catch((e) => console.log('  -> fail: ' + e.message));
