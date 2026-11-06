import type { SalesHistory } from './api';

// The history route's columns as one record per stored day (home.md 5.1). salesHistorySchema has already checked
// that the columns line up, so this only zips them.

export interface DayRecord {
  date: string;
  guests: number | null;
  netSalesCents: number | null;
  /** An index into the response's `uploads`, or -1 when the upload record is missing. */
  upload: number;
}

export function decodeHistory(body: SalesHistory): DayRecord[] {
  const { date, guests, netSalesCents, upload } = body.days;
  return date.map((day, index) => ({
    date: day,
    guests: guests[index] ?? null,
    netSalesCents: netSalesCents[index] ?? null,
    upload: upload[index] ?? -1,
  }));
}

export function byDate(days: readonly DayRecord[]): Map<string, DayRecord> {
  return new Map(days.map((day) => [day.date, day]));
}
