// Emails for signature requests. Sent through the SMTP server in SMTP_URL
// (for example smtps://user:password@smtp.example.com); without it, emails
// are printed to the log so the server can be tried out locally.

import nodemailer from "nodemailer";

export function createMailer({ smtpUrl = process.env.SMTP_URL, from = process.env.MAIL_FROM, log = console.log } = {}) {
  const transport = smtpUrl ? nodemailer.createTransport(smtpUrl) : null;
  const sender = from || "PageRig <no-reply@localhost>";
  const outbox = [];
  return {
    outbox,
    async send({ to, replyTo, subject, text, attachments }) {
      const mail = { from: sender, to, replyTo: replyTo || undefined, subject, text, attachments };
      outbox.push(mail);
      if (outbox.length > 100) outbox.shift();
      if (!transport) {
        log(`[mail] to ${to}: ${subject}\n${text}\n`);
        return;
      }
      await transport.sendMail(mail);
    },
  };
}

const from = (env) => (env.sender_name ? `${env.sender_name}${env.sender_email ? ` (${env.sender_email})` : ""}` : "Someone");

export function requestEmail(env, signer, link) {
  return {
    to: `"${signer.name.replace(/"/g, "")}" <${signer.email}>`,
    replyTo: env.sender_email,
    subject: env.subject,
    text: [
      `Hello ${signer.name},`,
      "",
      `${from(env)} has sent you "${env.title}" to sign.`,
      ...(env.message ? ["", env.message] : []),
      "",
      `Review and sign: ${link}`,
      ...(env.expires_at ? ["", `This link works until ${new Date(env.expires_at).toUTCString()}.`] : []),
      "",
      "This link is personal to you, so please don't forward it.",
    ].join("\n"),
  };
}

export function reminderEmail(env, signer, link) {
  const mail = requestEmail(env, signer, link);
  return { ...mail, subject: `Reminder: ${env.subject}` };
}

export function completedEmail(env, recipient, pdf) {
  return {
    to: recipient,
    subject: `Completed: ${env.title}`,
    text: [
      `Everyone has signed "${env.title}".`,
      "",
      "The signed document is attached. Its last page is a certificate listing who signed and when.",
    ].join("\n"),
    attachments: [{ filename: `${env.title.replace(/[^\w .-]+/g, "_")} (signed).pdf`, content: Buffer.from(pdf) }],
  };
}

export function declinedEmail(env, signer, reason) {
  return {
    to: env.sender_email,
    subject: `Declined: ${env.title}`,
    text: [`${signer.name} (${signer.email}) declined to sign "${env.title}".`, ...(reason ? ["", `Their reason: ${reason}`] : [])].join("\n"),
  };
}
