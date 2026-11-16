const nodemailer = require('nodemailer');
const config = require('../config');
const log = require('../lib/log');

const { host, port, secure, user, pass, from } = config.mail;
const transport = host
  ? nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined })
  : null;

// Without SMTP configured, emails are printed to the console (development).
async function sendMail({ to, subject, text }) {
  if (!transport) {
    console.log(`\n--- email (SMTP not configured) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n-----------------------------------\n`);
    return true;
  }
  await transport.sendMail({ from, to, subject, text });
  return true;
}

// Like sendMail but reports failure instead of throwing (callers decide what to tell the user).
async function trySendMail(msg) {
  try { return await sendMail(msg); }
  catch (e) { log.error('mail failed', { event: 'mail.failed', to: log.maskEmail(msg.to), subject: msg.subject, err: e }); return false; }
}

// Fire-and-forget: the request does not wait for the mail server (so a slow SMTP cannot slow or time a response).
// Failures are logged. `flushMail()` resolves when everything queued so far has been attempted (used on shutdown and in tests).
const inFlight = new Set();
function queueMail(msg) {
  const p = trySendMail(msg).finally(() => inFlight.delete(p));
  inFlight.add(p);
}
// Runs `fn` after the response has gone out, tracked like a queued mail (errors are logged, never thrown at the request).
function background(fn) {
  const p = Promise.resolve().then(fn).catch((e) => log.error('background job failed', { event: 'job.failed', err: e })).finally(() => inFlight.delete(p));
  inFlight.add(p);
}
const flushMail = () => Promise.all([...inFlight]);

module.exports = { sendMail, trySendMail, queueMail, background, flushMail };
