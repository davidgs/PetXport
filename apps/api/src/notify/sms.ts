import { env, features } from '../env.js';
import { stopTexts } from './stop.js';

/** Texts "sent" during tests. */
export const smsOutbox: { to: string; body: string }[] = [];

/**
 * Sends a text through Brevo's transactional SMS API (the same Brevo account that carries
 * the email). Brevo wants the number as digits with the country code and no "+".
 */
export async function sendSms(to: string, body: string): Promise<void> {
  if (env.isTest) {
    smsOutbox.push({ to: normalizePhone(to), body });
    return;
  }
  if (!features.sms) throw new Error('SMS is not configured');
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/send', {
    method: 'POST',
    headers: { 'api-key': env.brevoApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: env.brevoSmsSender,
      recipient: normalizePhone(to).replace(/^\+/, ''),
      content: body,
      type: 'transactional',
      // Without this, an emoji or accented letter in an organization's name is garbled.
      unicodeEnabled: /[^\x20-\x7e\n]/.test(body),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    const why = err?.message ?? `Brevo returned ${res.status}`;
    if (refusedAsStopped(err?.code, err?.message)) {
      // They replied STOP at some point and Brevo will not text them: record that on our side too.
      const profiles = await stopTexts(to).catch(() => 0);
      console.warn(`Brevo refused a text to a number that has opted out (${err?.code ?? res.status}); switched off ${profiles} profile(s).`);
      throw new Error(`recipient has opted out of texts: ${why}`);
    }
    console.warn(`Brevo refused a text (${res.status} ${err?.code ?? ''}): ${why}`);
    throw new Error(why);
  }
}

/**
 * Whether Brevo's refusal means the person has opted out (replied STOP), as opposed to a bad
 * number, no credit and so on. Brevo does not document the exact wording, so this looks for the
 * terms it uses for opted-out contacts.
 */
export function refusedAsStopped(code: string | undefined, message: string | undefined): boolean {
  return /black\s?list|block\s?list|unsubscrib|opt(ed)?[\s-]?out|stop(ped)?\b/i.test(`${code ?? ''} ${message ?? ''}`);
}

/** Best-effort E.164: bare 10-digit numbers are treated as US/Canada. */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}
