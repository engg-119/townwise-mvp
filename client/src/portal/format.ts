// Numbers, dates and times in the portal's voice (spec 15.7): thousands commas, dates with their year
// ("Mar 2, 2026"), times as "3:42 PM" in the viewer's time zone, "{n} days". Written by hand, as in
// src/chat/format.ts, so every platform prints the same text.

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatCount(value: number): string {
  const sign = value < 0 ? '−' : '';
  return sign + String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1 day", "12 days", "1,204 days". */
export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/**
 * "Mar 2, 2026". A calendar date (YYYY-MM-DD) is read without a time zone; an ISO time is read in the
 * viewer's time zone. Anything else is returned as it is.
 */
export function formatDate(value: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day !== null) {
    const month = SHORT_MONTHS[Number(day[2]) - 1];
    return month === undefined ? value : `${month} ${String(Number(day[3]))}, ${day[1] ?? ''}`;
  }
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return `${SHORT_MONTHS[time.getMonth()] ?? ''} ${String(time.getDate())}, ${String(time.getFullYear())}`;
}

/** "3:42 PM" in the viewer's time zone. */
export function formatTime(value: string | Date): string {
  const time = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(time.getTime())) return typeof value === 'string' ? value : '';
  const hours = time.getHours();
  const minutes = String(time.getMinutes()).padStart(2, '0');
  return `${String(hours % 12 === 0 ? 12 : hours % 12)}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "Hanover, NH". */
export function townLabel(town: { name: string; state: string }): string {
  return `${town.name}, ${town.state}`;
}

export function roleLabel(role: 'org_admin' | 'member'): 'Admin' | 'Member' {
  return role === 'org_admin' ? 'Admin' : 'Member';
}
