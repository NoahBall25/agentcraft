// Claude usage limits: "You've hit your session limit · resets 9:40pm (America/Toronto)".
// A turn that fails this way can simply run again once the limit resets, so the team schedules
// the retry instead of leaving the task blocked until someone notices.

/** Extra wait after the advertised reset, so the retry doesn't land a few seconds early. */
export const RESET_GRACE_MS = 2 * 60_000;
/** Never schedule further out than this (a misparsed date must not park a task for weeks). */
const MAX_WAIT_MS = 8 * 24 * 3600_000;

const LIMIT_RE = /\b(?:hit your|reached your|exceeded your)\b[^.]*?\blimit\b|\busage limit\b|\bsession limit\b|\bweekly limit\b/i;
const RESET_RE =
  /\bresets?\s+(?:at\s+|on\s+)?(?:(?<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?<day>\d{1,2})(?:st|nd|rd|th)?,?\s*(?:at\s+)?)?(?<h>\d{1,2})(?::(?<m>\d{2}))?\s*(?<ap>am|pm)?(?:\s*\((?<tz>[A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function isUsageLimit(text: string): boolean {
  return LIMIT_RE.test(text);
}

/** Wall-clock parts of `at` in `tz`. */
function partsIn(at: Date, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute! };
}

/** The instant whose wall clock in `tz` reads y-mo-d h:mi (DST-correct to the minute). */
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(t), tz);
    t += guess - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return new Date(t);
}

function validZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/**
 * When a usage limit in `text` resets: the next time after `now` that matches "resets 9:40pm
 * (America/Toronto)", "resets 4pm", "resets Oct 17, 9am (Europe/London)" and the like.
 * Undefined when the text isn't a usage-limit error or names no reset time.
 */
export function parseLimitReset(text: string, now: Date = new Date(), localZone?: string): Date | undefined {
  if (!isUsageLimit(text)) return undefined;
  const m = RESET_RE.exec(text);
  if (!m?.groups) return undefined;
  const g = m.groups;
  let h = Number(g.h);
  const mi = g.m ? Number(g.m) : 0;
  if (g.ap) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (g.ap.toLowerCase() === 'pm' ? 12 : 0);
  } else if (!g.m) {
    return undefined; // a bare number ("resets 5") is too ambiguous to schedule on
  }
  if (h > 23 || mi > 59) return undefined;
  const tz = validZone(g.tz) ?? validZone(localZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = partsIn(now, tz);
  let at: Date;
  if (g.mon) {
    const mo = MONTHS.indexOf(g.mon.toLowerCase().slice(0, 3)) + 1;
    at = zonedInstant(today.y, mo, Number(g.day), h, mi, tz);
    if (at.getTime() < now.getTime() - 24 * 3600_000) at = zonedInstant(today.y + 1, mo, Number(g.day), h, mi, tz);
  } else {
    at = zonedInstant(today.y, today.mo, today.d, h, mi, tz);
    // already past today: the next occurrence is tomorrow at that wall-clock time
    if (at.getTime() <= now.getTime()) {
      const tomorrow = partsIn(new Date(at.getTime() + 26 * 3600_000), tz);
      at = zonedInstant(tomorrow.y, tomorrow.mo, tomorrow.d, h, mi, tz);
    }
  }
  if (at.getTime() - now.getTime() > MAX_WAIT_MS) return undefined;
  return at;
}

/** The reset time from a failed turn's error texts, if any of them is a usage limit. */
export function limitResetFrom(texts: (string | undefined)[], now: Date = new Date()): Date | undefined {
  for (const t of texts) {
    if (!t) continue;
    const at = parseLimitReset(t, now);
    if (at) return at;
  }
  return undefined;
}

/** blockedReason for a task waiting on a usage limit; carries the retry time so it survives restarts. */
export const LIMIT_REASON_PREFIX = 'usage limit; auto-retry after ';

export function limitBlockedReason(at: Date): string {
  return `${LIMIT_REASON_PREFIX}${at.toISOString()}`;
}

export function retryAtFromReason(reason: string | undefined): Date | undefined {
  if (!reason?.startsWith(LIMIT_REASON_PREFIX)) return undefined;
  const at = new Date(reason.slice(LIMIT_REASON_PREFIX.length).trim());
  return Number.isNaN(at.getTime()) ? undefined : at;
}
