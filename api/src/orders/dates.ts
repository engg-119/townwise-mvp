// The order board's calendar words, shared by engine.ts and board.ts. Dates are 'YYYY-MM-DD' read as UTC, so a weekday
// never depends on the server's zone. Pure.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function at(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function addDays(iso: string, days: number): string {
  const date = at(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 'Wednesday'. */
export function weekdayName(iso: string): string {
  return WEEKDAYS[at(iso).getUTCDay()] ?? '';
}

/** 'Wed, Nov 18'. */
export function shortDate(iso: string): string {
  const date = at(iso);
  return `${weekdayName(iso).slice(0, 3)}, ${SHORT_MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
}

/** '14:00' as '2:00pm'. */
export function clockTime(hhmm: string): string {
  const [hours = '0', minutes = '00'] = hhmm.split(':');
  const hour = Number(hours);
  return `${String(hour % 12 === 0 ? 12 : hour % 12)}:${minutes}${hour < 12 ? 'am' : 'pm'}`;
}

/** 'Thursday’s delivery lasts until Monday’s.', or 'until next Thursday’s.' for a supplier who comes once a week. */
export function lastsUntil(delivery: string, next: string): string {
  const same = weekdayName(delivery) === weekdayName(next);
  return `${weekdayName(delivery)}’s delivery lasts until ${same ? 'next ' : ''}${weekdayName(next)}’s.`;
}
