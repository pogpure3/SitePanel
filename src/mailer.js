'use strict';

// SMTP-контракт совпадает с проектом PQR: его .env можно использовать без
// переименования переменных. Секреты читаются только из окружения.
const nodemailer = require('nodemailer');

const SMTP_CONFIG = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
};
const SMTP_FROM = process.env.SMTP_FROM || process.env.SMTP_USER || '';

let transporter = null;
function getTransporter() {
  if (!SMTP_CONFIG.host || !SMTP_FROM) return null;
  if (!transporter) transporter = nodemailer.createTransport(SMTP_CONFIG);
  return transporter;
}

async function sendEmail(to, subject, text) {
  const transport = getTransporter();
  if (!transport) return false;
  await transport.sendMail({ from: SMTP_FROM, to, subject, text });
  return true;
}

module.exports = { sendEmail };
