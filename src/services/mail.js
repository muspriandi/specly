const nodemailer = require('nodemailer');
const config = require('../config');

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
  catch (e) { console.error('mail failed:', e.message); return false; }
}

module.exports = { sendMail, trySendMail };
