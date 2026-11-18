import { describe, expect, it } from 'vitest';
import { refusedAsStopped } from '../src/notify/sms.js';

describe('texts Brevo refuses', () => {
  it('tells an opted-out number from other refusals', () => {
    expect(refusedAsStopped('invalid_parameter', 'Contact is blacklisted')).toBe(true);
    expect(refusedAsStopped('blocklisted_contact', undefined)).toBe(true);
    expect(refusedAsStopped(undefined, 'Recipient has unsubscribed from SMS')).toBe(true);
    expect(refusedAsStopped(undefined, 'The number has opted out')).toBe(true);
    expect(refusedAsStopped('not_enough_credits', 'You do not have enough credits')).toBe(false);
    expect(refusedAsStopped('invalid_parameter', 'Invalid telephone number')).toBe(false);
    expect(refusedAsStopped(undefined, undefined)).toBe(false);
  });
});
