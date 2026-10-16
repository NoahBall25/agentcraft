import { describe, expect, it } from 'vitest';
import { isUsageLimit, limitBlockedReason, limitResetFrom, parseLimitReset, retryAtFromReason } from '../src/agents/usagelimit.js';

const TOR = 'America/Toronto';
const at = (iso: string) => new Date(iso);

describe('usage-limit reset parsing', () => {
  it('reads the CLI message with a zone, later the same day', () => {
    const r = parseLimitReset("Claude Code returned an error result: You've hit your session limit · resets 9:40pm (America/Toronto)", at('2026-10-15T21:10:00Z'));
    expect(r?.toISOString()).toBe('2026-10-16T01:40:00.000Z'); // 21:40 EDT
  });

  it('rolls to tomorrow when the time has passed', () => {
    const r = parseLimitReset("You've hit your session limit · resets 4pm (America/Toronto)", at('2026-10-15T21:10:00Z')); // 17:10 EDT
    expect(r?.toISOString()).toBe('2026-10-16T20:00:00.000Z');
  });

  it('uses the right UTC offset on each side of a DST change', () => {
    // Toronto falls back on 2026-11-01: 9am is 13:00Z before and 14:00Z after
    expect(parseLimitReset('session limit · resets 9am (America/Toronto)', at('2026-10-31T20:00:00Z'))?.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(parseLimitReset('session limit · resets 9am (America/Toronto)', at('2026-10-30T20:00:00Z'))?.toISOString()).toBe('2026-10-31T13:00:00.000Z');
  });

  it('handles 12am/12pm and a dated reset', () => {
    const now = at('2026-10-15T15:00:00Z');
    expect(parseLimitReset('session limit · resets 12pm (UTC)', now)?.toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(parseLimitReset('session limit · resets 12am (UTC)', now)?.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(parseLimitReset("You've hit your weekly limit · resets Oct 18, 9am (Europe/London)", now)?.toISOString()).toBe('2026-10-18T08:00:00.000Z');
  });

  it('falls back to the given zone when the message names none', () => {
    expect(parseLimitReset('usage limit reached, resets 5:30pm', at('2026-10-15T12:00:00Z'), TOR)?.toISOString()).toBe('2026-10-15T21:30:00.000Z');
  });

  it('ignores other errors, ambiguous times and far-off dates', () => {
    const now = at('2026-10-15T12:00:00Z');
    expect(parseLimitReset('Claude Code returned an error result: 401 invalid api key', now)).toBeUndefined();
    expect(parseLimitReset('the cache resets 9pm', now)).toBeUndefined(); // not a usage limit
    expect(parseLimitReset("You've hit your session limit · resets 5", now)).toBeUndefined();
    expect(parseLimitReset("You've hit your session limit", now)).toBeUndefined();
    expect(parseLimitReset('session limit · resets 13pm (UTC)', now)).toBeUndefined();
    expect(parseLimitReset('weekly limit · resets Dec 25, 9am (UTC)', now)).toBeUndefined(); // > 8 days out
    expect(isUsageLimit('You have reached your usage limit')).toBe(true);
  });

  it("finds the reset in any of a turn's error texts", () => {
    const r = limitResetFrom([undefined, 'turn timed out', "You've hit your session limit · resets 9:40pm (America/Toronto)"], at('2026-10-15T21:10:00Z'));
    expect(r?.toISOString()).toBe('2026-10-16T01:40:00.000Z');
    expect(limitResetFrom(['turn timed out'])).toBeUndefined();
  });

  it('round-trips the retry time through blockedReason', () => {
    const t = at('2026-10-16T01:40:00Z');
    expect(retryAtFromReason(limitBlockedReason(t))?.toISOString()).toBe(t.toISOString());
    expect(retryAtFromReason('session ended: error')).toBeUndefined();
    expect(retryAtFromReason(undefined)).toBeUndefined();
  });
});
