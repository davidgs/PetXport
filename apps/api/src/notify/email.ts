import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Emails "sent" while no SMTP server is configured (development and tests). */
export const outbox: Email[] = [];

let transport: Transporter | null = null;

export async function sendEmail(input: Email): Promise<void> {
  // Subjects contain names and titles typed by users; a line break there must never become a new header.
  const email = { ...input, subject: input.subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').slice(0, 250) };
  if (!env.smtpUrl) {
    outbox.push(email);
    if (outbox.length > 200) outbox.shift();
    if (!env.isTest) {
      console.log(`\n--- email (SMTP_URL not set, not sent) ---\nTo: ${email.to}\nSubject: ${email.subject}\n\n${email.text}\n---\n`);
    }
    return;
  }
  transport ??= nodemailer.createTransport(env.smtpUrl);
  await transport.sendMail({ from: env.mailFrom, ...email });
}
