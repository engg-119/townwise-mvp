// The cleaned copy of a read file (spec 11A): exactly the days written, as `date,guests,net_sales` with CRLF line ends,
// net sales in dollars with two decimals and an empty cell for none. Dates and numbers only, so it can carry no name
// and no formula.
import type { SalesDay } from './parse/days.ts';

function dollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  return `${String(whole)}.${String(cents % 100).padStart(2, '0')}`;
}

export function cleanCsv(days: readonly SalesDay[]): string {
  const lines = ['date,guests,net_sales'];
  for (const day of days) {
    lines.push(`${day.date},${day.guests === null ? '' : String(day.guests)},${day.netSalesCents === null ? '' : dollars(day.netSalesCents)}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}
