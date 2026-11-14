import type { SalesHistory } from './api';
import { typicalGuests } from './days';

// The history route's columns as one record per stored day (home.md 5.1). salesHistorySchema has already checked
// that the columns line up, so this only zips them, and gives each day its weekday's typical guests (spec D32).

export interface DayRecord {
  date: string;
  guests: number | null;
  netSalesCents: number | null;
  /** An index into the response's `uploads`, or -1 when the upload record is missing. */
  upload: number;
  /**
   * The median guests over the open days among the 8 same weekdays before this one (days.ts typicalGuests), null
   * with fewer than 3. decodeHistory sets it; a record built without its history has none, so it is never likely closed.
   */
  typicalGuests?: number | null;
}

export function decodeHistory(body: SalesHistory): DayRecord[] {
  const { date, guests, netSalesCents, upload } = body.days;
  const guestsOn = new Map(date.map((day, index) => [day, guests[index] ?? null]));
  return date.map((day, index) => ({
    date: day,
    guests: guests[index] ?? null,
    netSalesCents: netSalesCents[index] ?? null,
    upload: upload[index] ?? -1,
    typicalGuests: typicalGuests(day, (other) => guestsOn.get(other)),
  }));
}

export function byDate(days: readonly DayRecord[]): Map<string, DayRecord> {
  return new Map(days.map((day) => [day.date, day]));
}
