import type { Note } from '../locations/api';
import type { SalesHistory } from './api';
import { trustedGuestDays, typicalGuests } from './days';

// The history route's columns as one record per stored day (home.md 5.1). salesHistorySchema has already checked
// that the columns line up, so this only zips them, and gives each day its weekday's typical guests (spec D32). With the
// location's notes, a guest count one marks wrong (D67) reads as none, the stored count kept in `storedGuests` for the
// day panel; record views (Your data's upload days, onboarding) decode without notes and show what was uploaded.

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
  /** D67: the stored guest count of a day a note marks wrong, whose `guests` read as none; absent on any other day. */
  storedGuests?: number;
}

export function decodeHistory(body: SalesHistory, notes: readonly Note[] = []): DayRecord[] {
  const { date, guests, netSalesCents, upload } = body.days;
  const stored = date.map((day, index) => ({ date: day, guests: guests[index] ?? null }));
  const trusted = trustedGuestDays(stored, notes);
  const guestsOn = new Map(trusted.map((day) => [day.date, day.guests]));
  return date.map((day, index) => {
    const recorded = stored[index]?.guests ?? null;
    const reads = trusted[index]?.guests ?? null;
    return {
      date: day,
      guests: reads,
      netSalesCents: netSalesCents[index] ?? null,
      upload: upload[index] ?? -1,
      typicalGuests: typicalGuests(day, (other) => guestsOn.get(other)),
      ...(recorded !== null && reads === null ? { storedGuests: recorded } : {}),
    };
  });
}

export function byDate(days: readonly DayRecord[]): Map<string, DayRecord> {
  return new Map(days.map((day) => [day.date, day]));
}
