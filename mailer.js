const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendMail({ to, subject, html }) {
  return transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
}

function verificationEmail(link) {
  return `
    <p>Confirm your Mani Nums account by clicking the link below:</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link expires in 24 hours. If you didn't create a Mani Nums account, you can ignore this email.</p>
  `;
}

function resetEmail(link) {
  return `
    <p>Someone requested a password reset for this Mani Nums account.</p>
    <p><a href="${link}">${link}</a></p>
    <p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>
  `;
}

module.exports = { sendMail, verificationEmail, resetEmail };
