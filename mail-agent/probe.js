'use strict';

// Diagnostic: what will the internal mail server let THIS machine do?
//
// Run it on sys160. It performs an SMTP conversation up to RCPT TO and then
// aborts with RSET/QUIT — it never sends DATA, so no mail is delivered and
// nobody receives anything.
//
// The question it answers: does the server accept mail from this machine
// WITHOUT a login? Many internal servers grant unauthenticated relay to
// trusted IP ranges (typically their own subnet). sys160 is on the same
// subnet as the mail server, so it may be trusted where other machines
// are not — in which case the portal needs no mailbox credentials at all.
//
//   node probe.js
//   node probe.js --from portal@workspace.com --to someone@workspace.com

const net = require('net');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOST = arg('host', process.env.SMTP_HOST || '192.168.100.5');
const PORT = parseInt(arg('port', process.env.SMTP_PORT || '25'), 10);
const FROM = arg('from', 'portal@workspace.com');
const TO = arg('to', 'production@workspace.com');

const steps = [
  'EHLO onepws-portal',
  `MAIL FROM:<${FROM}>`,
  `RCPT TO:<${TO}>`,
  'RSET',
  'QUIT',
];

console.log(`Probing ${HOST}:${PORT}`);
console.log(`  from : ${FROM}`);
console.log(`  to   : ${TO}`);
console.log('  (no message is sent — the conversation stops before DATA)\n');

const sock = net.createConnection({ host: HOST, port: PORT, timeout: 15000 });
let buf = '';
let i = -1;
let rcptReply = null;

sock.on('connect', () => console.log(`connected\n`));

sock.on('data', (d) => {
  buf += d.toString();
  if (!/\r\n$/.test(buf)) return;
  const reply = buf.trim();
  buf = '';
  console.log('S: ' + reply);

  // Capture the reply to RCPT TO — that is the answer we care about.
  if (i >= 0 && steps[i].startsWith('RCPT TO')) rcptReply = reply;

  i++;
  if (i < steps.length) {
    console.log('C: ' + steps[i]);
    sock.write(steps[i] + '\r\n');
  }
});

sock.on('timeout', () => { console.log('\nTIMEOUT — no response from the server'); sock.destroy(); });
sock.on('error', (e) => console.log('\nERROR: ' + e.message));

sock.on('close', () => {
  console.log('\n' + '-'.repeat(64));
  if (!rcptReply) {
    console.log('RESULT: inconclusive — the conversation did not reach RCPT TO.');
    process.exit(1);
  }
  // Exit codes, so setup.ps1 can branch on the verdict:
  //   0  = no login needed      10 = login required      1 = inconclusive
  let code;
  if (/^2\d\d/.test(rcptReply)) {
    console.log('RESULT: This machine CAN send without a login.');
    console.log('        Leave SMTP_USER and SMTP_PASS blank in mail-agent\\.env');
    console.log(`        and set SMTP_FROM to ${FROM}`);
    console.log('        No mailbox account or password is needed.');
    code = 0;
  } else if (/^5\d\d/.test(rcptReply) && /auth/i.test(rcptReply)) {
    console.log('RESULT: The server requires a login from this machine.');
    console.log('        A real mailbox account (address + password) is needed.');
    console.log('        Ask IT for one, e.g. portal@workspace.com.');
    code = 10;
  } else {
    console.log('RESULT: The server refused the recipient: ' + rcptReply);
    console.log('        This may be the FROM address rather than authentication —');
    console.log('        try:  node probe.js --from <a known internal address>');
    code = 1;
  }
  console.log('-'.repeat(64));
  process.exit(code);
});
