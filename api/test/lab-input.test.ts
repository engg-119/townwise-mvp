// The forecast lab's input (pure): every date from the first day with guests to dataThrough + 182, the term and week of
// term from Hanover's calendar, the notes as three flags, the town's event groups, and the current published run. The
// numbers are synthetic.
import { describe, expect, it } from 'vitest';

import { daysBetween } from '../src/dates.ts';
import { HORIZON_DAYS, labInputOf, labInputSchema, type LabInput } from '../src/lab/input.ts';
import type { ForecastRow, ForecastRunRecord } from '../src/stores/forecasts.ts';
import type { LocationRecord } from '../src/stores/locations.ts';
import type { NoteRecord } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';

const CALIBRATION = { id: 'a1'.repeat(12), regimeStart: null };
const HANOVER: Pick<LocationRecord, 'town'> = { town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' } };
const TODAY = '2026-06-02';

function day(date: string, guests: number | null, netSalesCents: number | null = 100_00): SalesDay {
  return { date, guests, netSalesCents };
}

/** Synthetic guests on every day of the range but the ones left out. */
function history(from: string, to: string, skip: readonly string[] = []): SalesDay[] {
  const out: SalesDay[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    if (!skip.includes(date)) out.push(day(date, 40 + (at / 86_400_000) % 7));
  }
  return out;
}

function note(overrides: Partial<NoteRecord> & Pick<NoteRecord, 'kind' | 'startDate'>): NoteRecord {
  return {
    id: 'b2'.repeat(12), endDate: overrides.startDate, weekdays: null, effect: 'unknown', expectedGuests: null,
    detail: 'sentinel-note-detail', createdBy: 'c3'.repeat(12), createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
  };
}

function inputOf(days: readonly SalesDay[], notes: readonly NoteRecord[] = [], champion: Parameters<typeof labInputOf>[0]['champion'] = null): LabInput {
  const input = labInputOf({ calibration: CALIBRATION, location: HANOVER, days, notes, today: TODAY, champion });
  if (input === null) throw new Error('no input');
  return labInputSchema.parse(input);
}

function dayOf(input: LabInput, date: string): LabInput['days'][number] {
  const found = input.days.find((each) => each.date === date);
  if (found === undefined) throw new Error(`no ${date}`);
  return found;
}

describe('labInputOf', () => {
  it('covers every date from the first day with guests to dataThrough + 182 with no gaps', () => {
    const days = [
      day('2024-12-30', null), day('2024-12-31', 0),
      ...history('2025-01-02', '2026-05-31', ['2025-02-10', '2025-04-15']),
      day('2025-04-15', 0),
      day('2026-06-01', 0), day('2026-06-02', null),
    ];
    const input = inputOf(days);
    expect(input).toMatchObject({
      schema: 'townwise.lab-input/1', calibrationId: CALIBRATION.id, metric: 'guests', today: TODAY, dataThrough: '2026-05-31',
      horizonDays: 182, regimeStart: null, champion: null,
    });
    expect(input.days[0]?.date).toBe('2025-01-02');
    expect(input.days.at(-1)?.date).toBe('2026-11-29');
    expect(daysBetween('2026-05-31', '2026-11-29')).toBe(HORIZON_DAYS);
    expect(input.days).toHaveLength(daysBetween('2025-01-02', '2026-11-29') + 1);
    input.days.forEach((each, index) => {
      if (index > 0) expect(daysBetween(input.days[index - 1]?.date ?? '', each.date)).toBe(1);
    });
    // No stored row: null. A zero-guest day before the cutoff stays zero. After the cutoff: null, even with a row.
    expect(dayOf(input, '2025-02-10').guests).toBeNull();
    expect(dayOf(input, '2025-04-15').guests).toBe(0);
    expect(dayOf(input, '2026-06-01').guests).toBeNull();
    expect(input.days.filter((each) => each.date > '2026-05-31').every((each) => each.guests === null)).toBe(true);
  });

  it('is null with no day with guests', () => {
    expect(labInputOf({ calibration: CALIBRATION, location: HANOVER, days: [day('2026-01-01', 0), day('2026-01-02', null)], notes: [], today: TODAY, champion: null }))
      .toBeNull();
  });

  it('maps term season and weekOfTerm from the town calendar, interim with -1 between terms', () => {
    const input = inputOf(history('2025-01-02', '2026-05-31'));
    const term = (date: string) => ({ term: dayOf(input, date).term, weekOfTerm: dayOf(input, date).weekOfTerm });
    // Winter 2025: classes 2025-01-06 to 03-07, finals 03-10 to 03-14. A term runs through its finals (the notebook's
    // section 1), so the days between classes and finals are in it too.
    expect(term('2025-01-02')).toEqual({ term: 'interim', weekOfTerm: -1 });
    expect(term('2025-01-06')).toEqual({ term: 'winter', weekOfTerm: 0 });
    expect(term('2025-01-12')).toEqual({ term: 'winter', weekOfTerm: 0 });
    expect(term('2025-01-13')).toEqual({ term: 'winter', weekOfTerm: 1 });
    expect(term('2025-03-08')).toEqual({ term: 'winter', weekOfTerm: 8 });
    expect(term('2025-03-14')).toEqual({ term: 'winter', weekOfTerm: 9 });
    expect(term('2025-03-15')).toEqual({ term: 'interim', weekOfTerm: -1 });
    expect(term('2025-03-31')).toEqual({ term: 'spring', weekOfTerm: 0 });
    expect(term('2025-07-01')).toEqual({ term: 'summer', weekOfTerm: 0 });
    // Future days: fall 2026 classes start 2026-09-14.
    expect(term('2026-09-13')).toEqual({ term: 'interim', weekOfTerm: -1 });
    expect(term('2026-09-14')).toEqual({ term: 'fall', weekOfTerm: 0 });
    expect(term('2026-11-25')).toEqual({ term: 'fall', weekOfTerm: 10 });
    expect(term('2026-11-26')).toEqual({ term: 'interim', weekOfTerm: -1 });
  });

  it('counts a term already under way on the first day from its own first day of classes', () => {
    const input = inputOf(history('2025-02-03', '2026-05-31'));
    expect(input.days[0]).toMatchObject({ date: '2025-02-03', term: 'winter', weekOfTerm: 4 });
    // After the last class day, before finals: its classes entry ends before the first day.
    expect(inputOf(history('2025-03-09', '2026-05-31')).days[0]).toMatchObject({ date: '2025-03-09', term: 'winter', weekOfTerm: 8 });
  });

  it('maps notes: closure -> closed, private_event -> privateEvent, private_event with effect closed -> booked', () => {
    const notes = [
      note({ kind: 'closure', startDate: '2025-04-01', effect: 'closed' }),
      note({ kind: 'private_event', startDate: '2025-04-02', effect: 'more_guests' }),
      note({ kind: 'private_event', startDate: '2025-04-03', effect: 'closed' }),
      note({ kind: 'other', startDate: '2025-04-04', effect: 'closed' }),
      note({ kind: 'opening', startDate: '2025-04-05', effect: 'more_guests' }),
      // Mondays only, over two weeks: 2025-04-07 and 2025-04-14.
      note({ kind: 'closure', startDate: '2025-04-07', endDate: '2025-04-20', weekdays: [1], effect: 'closed' }),
      // A future closure the forecast should know.
      note({ kind: 'closure', startDate: '2026-07-04', effect: 'closed' }),
    ];
    const input = inputOf(history('2025-01-02', '2026-05-31'), notes);
    const flags = (date: string) => {
      const { closed, privateEvent, booked } = dayOf(input, date);
      return { closed, privateEvent, booked };
    };
    expect(flags('2025-04-01')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(flags('2025-04-02')).toEqual({ closed: false, privateEvent: true, booked: false });
    expect(flags('2025-04-03')).toEqual({ closed: false, privateEvent: true, booked: true });
    expect(flags('2025-04-04')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(flags('2025-04-05')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2025-04-07')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(flags('2025-04-08')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2025-04-14')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(flags('2026-07-04')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(input.days.filter((each) => each.closed)).toHaveLength(5);
  });

  it('lists town event groups sorted and one_off for an ungrouped event, and never a holiday, title, note detail or name', () => {
    const notes = [note({ kind: 'closure', startDate: '2025-07-04', effect: 'closed' })];
    const input = inputOf(history('2025-01-02', '2026-05-31'), notes);
    expect(dayOf(input, '2025-02-07').events).toEqual(['hanover-nh:winter-carnival']);
    expect(dayOf(input, '2025-10-11').events).toEqual(['hanover-nh:home-football', 'hanover-nh:homecoming']);
    // A key date with no group (Fall term classes begin) on the last day of orientation.
    expect(dayOf(input, '2026-09-14').events).toEqual(['hanover-nh:orientation', 'one_off']);
    // Federal holidays are not events: the lab computes them from the dates.
    for (const holiday of ['2025-07-04', '2025-11-27', '2025-12-25', '2026-01-01']) expect(dayOf(input, holiday).events).toEqual([]);
    const text = JSON.stringify(input);
    for (const absent of ['sentinel-note-detail', 'Hanover', 'Winter Carnival', 'Commencement', 'Thanksgiving', 'Fall term', 'us:']) {
      expect(text).not.toContain(absent);
    }
  });

  it('includes the current champion run rows and null without one', () => {
    const run = { id: 'd4'.repeat(12), dataThrough: '2026-03-31' } as ForecastRunRecord;
    const row = (overrides: Partial<ForecastRow>): ForecastRow => ({
      runId: run.id, span: 'day', from: '2026-04-01', to: '2026-04-01', status: 'open', low: 1, mid: 2, high: 3, baseline: 2,
      openDays: null, reasons: [{ kind: 'weekday', ref: null, effectPct: 5 }], ...overrides,
    });
    const rows = [
      row({ span: 'week', from: '2026-03-30', to: '2026-04-05', status: null, low: 10, mid: 12, high: 14, baseline: null, openDays: 4, reasons: [] }),
      row({ from: '2026-04-02', to: '2026-04-02', status: 'closed', low: null, mid: null, high: null, baseline: null }),
      row({}),
      row({ from: '2026-04-03', to: '2026-04-03', status: 'booked', low: null, mid: null, high: null, baseline: null }),
    ];
    const input = inputOf(history('2025-01-02', '2026-05-31'), [], { run, rows });
    expect(input.champion).toEqual({
      runId: run.id, dataThrough: '2026-03-31',
      days: [
        { date: '2026-04-01', status: 'open', low: 1, mid: 2, high: 3 },
        { date: '2026-04-02', status: 'closed', low: null, mid: null, high: null },
        { date: '2026-04-03', status: 'booked', low: null, mid: null, high: null },
      ],
      weeks: [{ from: '2026-03-30', to: '2026-04-05', openDays: 4, low: 10, mid: 12, high: 14 }],
    });
    expect(inputOf(history('2025-01-02', '2026-05-31')).champion).toBeNull();
  });

  it('carries the calibration’s pattern change date', () => {
    const input = labInputOf({
      calibration: { ...CALIBRATION, regimeStart: '2025-09-01' }, location: HANOVER, days: history('2025-01-02', '2026-05-31'), notes: [],
      today: TODAY, champion: null,
    });
    expect(input?.regimeStart).toBe('2025-09-01');
  });

  it('a town outside the researched twelve gets interim days and no events', () => {
    const input = labInputOf({
      calibration: CALIBRATION, location: { town: { townId: null, name: 'Elsewhere', state: 'VT' } },
      days: history('2025-01-02', '2026-05-31'), notes: [], today: TODAY, champion: null,
    });
    expect(input?.days.every((each) => each.term === 'interim' && each.weekOfTerm === -1 && each.events.length === 0)).toBe(true);
  });
});
