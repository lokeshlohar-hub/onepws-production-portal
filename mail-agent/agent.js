'use strict';

// ONEPWS Handover Mail Relay Agent — runs on sys160.
//
// Why this exists: the portal's backend runs on Google Cloud Run, and the
// factory's mail server (192.168.100.5) is a private LAN address with no route
// from the internet. The backend therefore renders each handover notification
// and parks it in the mail_outbox table; this agent — which IS on that LAN —
// polls the portal over HTTPS, delivers the message through the internal mail
// server, and reports the outcome back.
//
// All traffic is OUTBOUND from the factory (HTTPS to the portal, SMTP to the
// local mail server). Nothing needs to be exposed to the internet, and no
// firewall or router change is required.
//
// Configuration comes from mail-agent/.env — see .env.example.

// Load .env from THIS folder, not the caller's working directory — otherwise
// `node mail-agent/agent.js` from the repo root silently finds no settings.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const nodemailer = require('nodemailer');

const PORTAL_URL = (process.env.PORTAL_URL || '').replace(/\/+$/, '');
const AGENT_TOKEN = process.env.MAIL_AGENT_TOKEN || '';
const POLL_SECONDS = Math.max(5, parseInt(process.env.POLL_SECONDS, 10) || 20);

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 25;
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `ONEPWS Production Portal <${SMTP_USER}>` : '');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function requireConfig() {
  const missing = [];
  if (!PORTAL_URL) missing.push('PORTAL_URL');
  if (!AGENT_TOKEN) missing.push('MAIL_AGENT_TOKEN');
  if (!SMTP_HOST) missing.push('SMTP_HOST');
  // SMTP_USER/SMTP_PASS are intentionally optional: the internal mail server
  // may allow unauthenticated relay from trusted IPs (sys160 is on its own
  // subnet). Run `node probe.js` to find out which applies. When they are
  // blank, SMTP_FROM must be set so the message still has a sender.
  if (!SMTP_USER && !SMTP_FROM) missing.push('SMTP_FROM (or SMTP_USER)');
  if (missing.length) {
    console.error('Missing required settings in mail-agent/.env: ' + missing.join(', '));
    process.exit(1);
  }
}

// The internal server offers AUTH LOGIN on port 25 with no STARTTLS. That is
// acceptable here and only here: this connection never leaves the factory LAN.
// `ignoreTLS` stops nodemailer from attempting an upgrade the server does not
// advertise; requireTLS must stay off for the same reason.
function makeTransport() {
  // Passing an empty auth object makes nodemailer attempt AUTH with blank
  // credentials, which servers reject — omit it entirely for anonymous relay.
  const opts = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    ignoreTLS: !SMTP_SECURE,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  };
  if (SMTP_USER && SMTP_PASS) opts.auth = { user: SMTP_USER, pass: SMTP_PASS };
  return nodemailer.createTransport(opts);
}

async function portal(path, options) {
  const res = await fetch(PORTAL_URL + path, Object.assign({
    headers: {
      'X-Agent-Token': AGENT_TOKEN,
      'Content-Type': 'application/json',
    },
  }, options || {}));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status} ${body.error || ''}`.trim());
  }
  return body;
}

async function deliver(transport, msg) {
  const attachments = msg.pdfBase64 ? [{
    filename: msg.pdfName || 'Handover.pdf',
    content: Buffer.from(msg.pdfBase64, 'base64'),
    contentType: 'application/pdf',
  }] : [];

  await transport.sendMail({
    from: SMTP_FROM,
    to: (msg.to || []).join(', '),
    cc: (msg.cc || []).length ? msg.cc.join(', ') : undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments,
  });
}

let stopping = false;

async function tick(transport) {
  let batch;
  try {
    batch = await portal('/api/mail-agent/pending');
  } catch (err) {
    // Portal unreachable (internet blip, cold start). Nothing is lost — the
    // rows stay queued and the next poll picks them up.
    log('poll failed:', err.message);
    return;
  }

  const messages = batch.messages || [];
  if (!messages.length) return;
  log(`claimed ${messages.length} message(s)`);

  for (const msg of messages) {
    if (stopping) break;
    try {
      await deliver(transport, msg);
      await portal('/api/mail-agent/result', {
        method: 'POST',
        body: JSON.stringify({ id: msg.id, ok: true }),
      });
      log(`sent ${msg.id} -> ${(msg.to || []).join(', ')}`);
    } catch (err) {
      log(`FAILED ${msg.id} (attempt ${msg.attempts}):`, err.message);
      try {
        await portal('/api/mail-agent/result', {
          method: 'POST',
          body: JSON.stringify({ id: msg.id, ok: false, error: err.message }),
        });
      } catch (reportErr) {
        // Couldn't even report the failure; the row is left 'sending' and will
        // be picked up again once its attempt count allows.
        log('could not report failure:', reportErr.message);
      }
    }
  }
}

async function main() {
  // `node agent.js --check` verifies the configuration and exits, without
  // entering the poll loop — used by setup.ps1 to confirm the password and
  // token are right before anything is installed as a service.
  const checkOnly = process.argv.includes('--check');

  requireConfig();
  log(checkOnly ? 'ONEPWS mail relay agent — configuration check' : 'ONEPWS mail relay agent starting');
  log(`  portal : ${PORTAL_URL}`);
  log(`  smtp   : ${SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`
    + (SMTP_USER && SMTP_PASS ? ` as ${SMTP_USER}` : ' — no login (anonymous relay)'));
  log(`  from   : ${SMTP_FROM}`);
  if (!checkOnly) log(`  poll   : every ${POLL_SECONDS}s`);

  const transport = makeTransport();

  // Fail loudly at startup rather than silently never delivering: check both
  // the mail server and the portal token before entering the poll loop.
  try {
    await transport.verify();
    log('SMTP connection OK');
    if (!(SMTP_USER && SMTP_PASS)) {
      // Without credentials, verify() only proves the server answered — it
      // does not prove the server will accept our recipients. probe.js is
      // what actually confirms relay permission.
      log('  note: connected without a login. If sending later fails with a 5xx,');
      log('        run `node probe.js` to confirm this machine may relay.');
    }
  } catch (err) {
    console.error('SMTP check FAILED:', err.message);
    if (/535|authentication/i.test(err.message)) {
      console.error('  -> The mailbox username or password in mail-agent\\.env is wrong.');
    }
    process.exit(1);
  }
  try {
    const health = await portal('/api/mail-agent/health');
    log('portal OK, queue:', JSON.stringify(health.queue || {}));
  } catch (err) {
    console.error('Portal check FAILED:', err.message);
    if (/401/.test(err.message)) {
      // A rejected token can never fix itself, so there is no point polling.
      console.error('  -> MAIL_AGENT_TOKEN does not match the one set on the portal.');
      if (!checkOnly) process.exit(1);
    } else if (/503/.test(err.message)) {
      // The relay may simply not be switched on yet, or may be toggled off for
      // maintenance. Exiting here would make the Windows service flap and end
      // up paused; instead wait for it and start delivering when it appears.
      console.error('  -> The relay is not switched on at the portal yet.');
      console.error('     Waiting — delivery begins automatically once it is enabled.');
    } else {
      console.error('  -> Could not reach the portal (network or cold start). Will keep retrying.');
    }
  }

  if (checkOnly) {
    log('configuration check passed');
    process.exit(0);
  }

  const loop = async () => {
    if (stopping) return;
    await tick(transport).catch((e) => log('tick error:', e.message));
    if (!stopping) setTimeout(loop, POLL_SECONDS * 1000);
  };
  loop();
}

['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => {
  log(`${sig} received, finishing current message then exiting`);
  stopping = true;
  setTimeout(() => process.exit(0), 2000);
}));

main();
