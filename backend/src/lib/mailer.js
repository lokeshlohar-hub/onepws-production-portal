'use strict';

// Outbound email for Handover Notifications.
//
// Configured entirely through environment variables so no credential is ever
// committed. Until SMTP_HOST/SMTP_USER/SMTP_PASS are set, isMailConfigured()
// returns false and the send endpoint reports that cleanly — the frontend then
// falls back to its existing mailto: + printable-document flow, so the feature
// degrades to exactly today's behaviour rather than breaking.
//
//   SMTP_HOST    mail server hostname        (e.g. smtp.workspace.com)
//   SMTP_PORT    465 (implicit TLS) or 587 (STARTTLS). NOTE: Cloud Run blocks
//                outbound port 25 permanently — 465/587 are the usable ports.
//   SMTP_SECURE  "true" for 465, "false" for 587. Defaults from the port.
//   SMTP_USER    login (e.g. production@workspace.com)
//   SMTP_PASS    password
//   SMTP_FROM    From header. Defaults to "ONEPWS Production Portal <SMTP_USER>".
//   SMTP_REJECT_UNAUTHORIZED  "false" only if the server uses a self-signed
//                certificate (common for on-prem mail servers).

const nodemailer = require('nodemailer');

function cfg() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';
  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  // Port 465 is implicit TLS; 587 is STARTTLS. Explicit override wins.
  const secure = process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ''
    ? String(process.env.SMTP_SECURE).toLowerCase() === 'true'
    : port === 465;
  const from = (process.env.SMTP_FROM || '').trim()
    || (user ? `ONEPWS Production Portal <${user}>` : '');
  const rejectUnauthorized = String(process.env.SMTP_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false';
  return { host, port, secure, user, pass, from, rejectUnauthorized };
}

function isMailConfigured() {
  const c = cfg();
  return Boolean(c.host && c.user && c.pass);
}

// Built lazily and cached: nodemailer pools connections, and creating the
// transport at module load would fail the whole server start when SMTP isn't
// configured yet.
let _transport = null;
function transport() {
  if (_transport) return _transport;
  const c = cfg();
  if (!c.host || !c.user || !c.pass) {
    throw new Error('SMTP is not configured (need SMTP_HOST, SMTP_USER, SMTP_PASS)');
  }
  _transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    tls: { rejectUnauthorized: c.rejectUnauthorized },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return _transport;
}

// Used by the /api/handover-log/mail-status diagnostic so a misconfiguration
// surfaces as a clear message instead of a failed send later.
async function verifyConnection() {
  await transport().verify();
  return true;
}

async function sendHandoverMail({ to, cc, subject, html, text, attachments }) {
  const c = cfg();
  const info = await transport().sendMail({
    from: c.from,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: Array.isArray(cc) && cc.length ? cc.join(', ') : undefined,
    subject,
    text,
    html,
    attachments: attachments || [],
  });
  return { messageId: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
}

// Safe to log / return to the client — never includes the password.
function mailConfigSummary() {
  const c = cfg();
  return {
    configured: isMailConfigured(),
    host: c.host || null,
    port: c.host ? c.port : null,
    secure: c.host ? c.secure : null,
    user: c.user || null,
    from: c.from || null,
  };
}

module.exports = { isMailConfigured, sendHandoverMail, verifyConnection, mailConfigSummary };
