// The forecast lab's input (pure): every date from the first day with guests to dataThrough + 182, the term and week of
// term from Hanover's calendar, the notes as three flags, the town's event groups, and the current published run. The
// numbers are synthetic. The last test holds the API's input to the lab's own validator through a golden file.
import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { daysBetween } from '../src/dates.ts';
import { eachDay } from '../src/forecasts/file.ts';
import { HORIZON_DAYS, labInputOf, labInputSchema, type LabInput } from '../src/lab/input.ts';
import type { ScheduledRule } from '../src/forecasts/adjust.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
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
    detail: 'sentinel-note-detail', startTime: null, endTime: null, createdBy: 'c3'.repeat(12), byStaff: false, source: null, createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
  };
}

function inputOf(
  days: readonly SalesDay[], notes: readonly NoteRecord[] = [], champion: Parameters<typeof labInputOf>[0]['champion'] = null,
  rules: readonly ScheduledRule[] = [],
): LabInput {
  const input = labInputOf({ calibration: CALIBRATION, location: HANOVER, days, notes, rules, today: TODAY, champion });
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
    // No stored row: null. A zero-guest day with sales among days of about 43 guests is likely closed (spec D32): closed,
    // with no guest count (the next tests). After the cutoff: null, even with a row.
    expect(dayOf(input, '2025-02-10').guests).toBeNull();
    expect(dayOf(input, '2025-04-15')).toMatchObject({ guests: null, closed: true });
    expect(dayOf(input, '2026-06-01').guests).toBeNull();
    expect(input.days.filter((each) => each.date > '2026-05-31').every((each) => each.guests === null)).toBe(true);
  });

  it('is null with no day with guests', () => {
    expect(labInputOf({ calibration: CALIBRATION, location: HANOVER, days: [day('2026-01-01', 0), day('2026-01-02', null)], notes: [], rules: [], today: TODAY, champion: null }))
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
      // A future closure: left to the forecast read (spec 14.5), so the next test pins it false.
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
    expect(flags('2026-07-04')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(input.days.filter((each) => each.closed)).toHaveLength(4);
  });

  it('after dataThrough, closures, buyouts and a private event with a guest count are left to the read; one without a count stays true; history days keep their flags but a counted party', () => {
    const notes = [
      // History days (dataThrough is 2026-05-31) keep their flags for training, but a counted party's (the next test).
      note({ kind: 'private_event', startDate: '2026-05-30', effect: 'more_guests', expectedGuests: 70 }),
      note({ kind: 'private_event', startDate: '2026-05-31', effect: 'more_guests' }),
      note({ kind: 'closure', startDate: '2026-05-29', effect: 'closed' }),
      note({ kind: 'private_event', startDate: '2026-05-28', effect: 'closed', expectedGuests: 90 }),
      // After dataThrough: the read layer adds a counted party, books a buyout's day and closes a closure's (spec 14.5),
      // so the lab must not apply its lift too, and a run never bakes in a status the owner can't undo by editing the note.
      note({ kind: 'closure', startDate: '2026-06-08', effect: 'closed' }),
      note({ kind: 'other', startDate: '2026-06-09', effect: 'closed', detail: 'x' }),
      note({ kind: 'private_event', startDate: '2026-06-10', effect: 'more_guests', expectedGuests: 70 }),
      note({ kind: 'private_event', startDate: '2026-06-11', effect: 'more_guests' }),
      note({ kind: 'private_event', startDate: '2026-06-12', effect: 'closed', expectedGuests: 90 }),
      note({ kind: 'private_event', startDate: '2026-06-13', effect: 'fewer_guests', expectedGuests: 20 }),
      // Two on one day: the uncounted one still marks it.
      note({ kind: 'private_event', startDate: '2026-06-14', effect: 'more_guests', expectedGuests: 40 }),
      note({ kind: 'private_event', startDate: '2026-06-14', effect: 'unknown' }),
    ];
    const input = inputOf(history('2025-01-02', '2026-05-31'), notes);
    expect(input.dataThrough).toBe('2026-05-31');
    const flags = (date: string) => {
      const { closed, privateEvent, booked } = dayOf(input, date);
      return { closed, privateEvent, booked };
    };
    expect(flags('2026-05-28')).toEqual({ closed: false, privateEvent: true, booked: true });
    expect(flags('2026-05-29')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(flags('2026-05-30')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-05-31')).toEqual({ closed: false, privateEvent: true, booked: false });
    expect(flags('2026-06-08')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-06-09')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-06-10')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-06-11')).toEqual({ closed: false, privateEvent: true, booked: false });
    expect(flags('2026-06-12')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-06-13')).toEqual({ closed: false, privateEvent: true, booked: false });
    expect(flags('2026-06-14')).toEqual({ closed: false, privateEvent: true, booked: false });
  });

  it('a likely-closed history day (spec D32) is closed with no guest count, so the lab neither learns from it nor reads it as open', () => {
    // About 43 guests a day; three near-empty Saturdays, one all-zero Saturday, and two notes saying open.
    const near = ['2026-04-04', '2026-04-11', '2026-04-18'];
    const days = history('2025-01-02', '2026-05-31').map((each) => {
      if (near.includes(each.date)) return day(each.date, 1);
      return each.date === '2026-04-25' ? day(each.date, 0, 0) : each;
    });
    const notes = [
      note({ kind: 'other', startDate: '2026-04-11', effect: 'fewer_guests' }),
      note({ kind: 'private_event', startDate: '2026-04-18', effect: 'more_guests' }),
    ];
    const input = inputOf(days, notes);
    expect(dayOf(input, '2026-04-04')).toMatchObject({ guests: null, closed: true, privateEvent: false, booked: false });
    // A note with more or fewer guests says the day was open: a real slow day the lab learns from.
    expect(dayOf(input, '2026-04-11')).toMatchObject({ guests: 1, closed: false });
    expect(dayOf(input, '2026-04-18')).toMatchObject({ guests: 1, closed: false, privateEvent: true });
    // An all-zero day already reads as closed in the lab (no guests): unchanged.
    expect(dayOf(input, '2026-04-25')).toMatchObject({ guests: 0, closed: false });
    expect(dayOf(input, '2026-04-03')).toMatchObject({ closed: false });
    expect(input.days.filter((each) => each.closed).map((each) => each.date)).toEqual(['2026-04-04']);
    // The first weeks have too few of their weekday before them for a typical count, so a near-empty one keeps its guests.
    const early = inputOf([...history('2025-01-02', '2025-01-17'), day('2025-01-18', 1), ...history('2025-01-19', '2026-05-31')]);
    expect(dayOf(early, '2025-01-18')).toMatchObject({ guests: 1, closed: false });
  });

  it('a business rule’s schedule (D31) sets the flags as a note would, on history and future days, and never its text', () => {
    const rule = (id: string, fields: Partial<RuleSchedule> & Pick<RuleSchedule, 'kind' | 'startDate' | 'effect'>): ScheduledRule => ({
      id: id.repeat(24), schedule: { endDate: null, weekdays: null, expectedGuests: null, startTime: null, endTime: null, ...fields },
    });
    const rules = [
      // Closed Mondays from April 2025, with no end: history Mondays closed, future ones left to the read.
      rule('1', { kind: 'closure', startDate: '2025-04-07', weekdays: [1], effect: 'closed' }),
      // A party every Friday in May 2026 and June 2026: privateEvent on history Fridays; on future ones only without a count.
      rule('2', { kind: 'private_event', startDate: '2026-05-01', endDate: '2026-06-30', weekdays: [5], effect: 'more_guests', expectedGuests: 40 }),
      rule('3', { kind: 'private_event', startDate: '2026-06-01', endDate: '2026-06-30', weekdays: [6], effect: 'more_guests' }),
      // A buyout on one history Sunday.
      rule('4', { kind: 'private_event', startDate: '2026-05-03', endDate: '2026-05-03', effect: 'closed', expectedGuests: 80 }),
    ];
    // The Mondays the rule closed have no row, as a closed day's export does.
    const mondays = eachDay('2025-04-07', '2026-05-31').filter((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1);
    const days = history('2025-01-02', '2026-05-31', mondays);
    const withRules = inputOf(days, [], null, rules);
    const flags = (date: string) => {
      const { closed, privateEvent, booked } = dayOf(withRules, date);
      return { closed, privateEvent, booked };
    };
    // The same flags and guests a note with these fields gives.
    const asNotes = inputOf(days, rules.map((each) => note({
      ...each.schedule, endDate: each.schedule.endDate ?? '2026-11-29', detail: null,
    })));
    expect(withRules.days).toEqual(asNotes.days);
    expect(flags('2025-04-07')).toEqual({ closed: true, privateEvent: false, booked: false });
    expect(flags('2026-05-25')).toEqual({ closed: true, privateEvent: false, booked: false });
    // A counted party on a history Friday: its guests are the read's (next test), so no flag.
    expect(flags('2026-05-29')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-05-03')).toEqual({ closed: false, privateEvent: true, booked: true });
    // After dataThrough (2026-05-31): closures and counted parties are the read's; an uncounted party still marks the day.
    expect(flags('2026-06-01')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-06-05')).toEqual({ closed: false, privateEvent: false, booked: false });
    expect(flags('2026-06-06')).toEqual({ closed: false, privateEvent: true, booked: false });
    expect(withRules.days.filter((each) => each.closed && each.date > '2026-05-31')).toEqual([]);
    expect(JSON.stringify(withRules)).not.toContain('1'.repeat(24));
  });

  it('a past day’s real guests beat a rule’s closure, which closes only a day with few or no guests; a closure note still closes it (spec D31, D32)', () => {
    const closedMondays: ScheduledRule = {
      id: '6'.repeat(24),
      schedule: { kind: 'closure', startDate: '2026-04-06', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    };
    // About 43 a day; Apr 13 near empty, Apr 20 no row, Apr 27 and May 4 open as usual.
    const days = history('2025-01-02', '2026-05-31', ['2026-04-20']).map((each) => (each.date === '2026-04-13' ? day(each.date, 2) : each));
    const input = inputOf(days, [], null, [closedMondays]);
    expect(dayOf(input, '2026-04-27')).toMatchObject({ guests: expect.any(Number) as number, closed: false });
    expect(dayOf(input, '2026-05-04')).toMatchObject({ closed: false });
    expect(dayOf(input, '2026-04-13')).toMatchObject({ guests: 2, closed: true });
    expect(dayOf(input, '2026-04-20')).toMatchObject({ guests: null, closed: true });
    // A closure note on the same days keeps closing them all.
    const noted = inputOf(days, [note({ kind: 'closure', startDate: '2026-04-06', endDate: '2026-05-31', weekdays: [1], effect: 'closed' })]);
    expect(['2026-04-13', '2026-04-20', '2026-04-27', '2026-05-04'].map((date) => dayOf(noted, date).closed)).toEqual([true, true, true, true]);
    // A one-day opening note beats a rule's buyout.
    const buyouts: ScheduledRule = { id: '7'.repeat(24), schedule: { ...closedMondays.schedule, kind: 'private_event', weekdays: [0] } };
    const opened = inputOf(days, [note({ kind: 'opening', startDate: '2026-05-03' })], null, [buyouts]);
    expect(dayOf(opened, '2026-05-03')).toMatchObject({ closed: false, privateEvent: false, booked: false });
    expect(dayOf(opened, '2026-05-10')).toMatchObject({ privateEvent: true, booked: true });
  });

  it('a counted party on a history day sends base demand: its guests less the party, never below 0, and no privateEvent (notes and rules alike)', () => {
    // A party of 70 on May 30 with 150 guests, one of 40 every May Friday with 43ish, and one with no count on May 31.
    const days = history('2025-01-02', '2026-05-31').map((each) => (each.date === '2026-05-30' ? day(each.date, 150) : each));
    const notes = [
      note({ kind: 'private_event', startDate: '2026-05-30', effect: 'more_guests', expectedGuests: 70 }),
      note({ kind: 'private_event', startDate: '2026-05-31', effect: 'more_guests' }),
    ];
    const fridays: ScheduledRule = {
      id: '8'.repeat(24),
      schedule: { kind: 'private_event', startDate: '2026-05-01', endDate: '2026-05-31', weekdays: [5], effect: 'more_guests', expectedGuests: 40, startTime: null, endTime: null },
    };
    const input = inputOf(days, notes, null, [fridays]);
    const stored = (date: string): number => days.find((each) => each.date === date)?.guests ?? -1;
    expect(dayOf(input, '2026-05-30')).toMatchObject({ guests: 80, privateEvent: false, closed: false });
    expect(dayOf(input, '2026-05-29')).toMatchObject({ guests: stored('2026-05-29') - 40, privateEvent: false });
    expect(dayOf(input, '2026-05-31')).toMatchObject({ guests: stored('2026-05-31'), privateEvent: true });
    const small = inputOf(days, [note({ kind: 'private_event', startDate: '2026-05-28', effect: 'more_guests', expectedGuests: 500 })]);
    expect(dayOf(small, '2026-05-28')).toMatchObject({ guests: 0, privateEvent: false });
  });

  it('never calls today’s near-empty row likely closed: its upload may be partial (spec D32)', () => {
    const input = inputOf([...history('2025-01-02', '2026-05-31'), day('2026-06-01', 1), day(TODAY, 1)]);
    expect(dayOf(input, '2026-06-01')).toMatchObject({ guests: null, closed: true });
    expect(dayOf(input, TODAY)).toMatchObject({ guests: 1, closed: false });
  });

  it('a rule with more or fewer guests says a near-empty history day was open, as a note does (spec D32)', () => {
    const days = history('2025-01-02', '2026-05-31').map((each) => (['2026-04-04', '2026-04-11'].includes(each.date) ? day(each.date, 1) : each));
    const slowSaturdays: ScheduledRule = {
      id: '5'.repeat(24),
      schedule: { kind: 'other', startDate: '2026-04-11', endDate: null, weekdays: [6], effect: 'fewer_guests', expectedGuests: null, startTime: null, endTime: null },
    };
    const input = inputOf(days, [], null, [slowSaturdays]);
    expect(dayOf(input, '2026-04-04')).toMatchObject({ guests: null, closed: true });
    expect(dayOf(input, '2026-04-11')).toMatchObject({ guests: 1, closed: false });
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
      calibration: { ...CALIBRATION, regimeStart: '2025-09-01' }, location: HANOVER, days: history('2025-01-02', '2026-05-31'), notes: [], rules: [],
      today: TODAY, champion: null,
    });
    expect(input?.regimeStart).toBe('2025-09-01');
  });

  it('stops at today: a guest day after the town’s today is not history yet', () => {
    const days = [...history('2025-01-02', '2026-06-02'), day('2026-06-03', 77)];
    const input = inputOf(days);
    expect(input.dataThrough).toBe(TODAY);
    expect(dayOf(input, '2026-06-03').guests).toBeNull();
    expect(input.days.at(-1)?.date).toBe('2026-12-01');
    // Only days after today: nothing to calibrate on.
    expect(labInputOf({ calibration: CALIBRATION, location: HANOVER, days: [day('2026-06-03', 77)], notes: [], rules: [], today: TODAY, champion: null }))
      .toBeNull();
  });

  it('labInputSchema refuses a last day of data after today, as the lab’s validator does', () => {
    const input = inputOf(history('2025-01-02', '2026-05-31'));
    expect(labInputSchema.safeParse({ ...input, today: '2026-05-30' }).success).toBe(false);
    expect(labInputSchema.safeParse({ ...input, today: input.dataThrough }).success).toBe(true);
  });

  it('a town outside the researched twelve gets interim days and no events', () => {
    const input = labInputOf({
      calibration: CALIBRATION, location: { town: { townId: null, name: 'Elsewhere', state: 'VT' } },
      days: history('2025-01-02', '2026-05-31'), notes: [], rules: [], today: TODAY, champion: null,
    });
    expect(input?.days.every((each) => each.term === 'interim' && each.weekOfTerm === -1 && each.events.length === 0)).toBe(true);
  });
});

/**
 * The API's side of the lab contract: an input labInputOf builds, from 637 days of synthetic Hanover history (a gap, zero
 * days, a row after today), notes of each kind, a pattern change date and a current forecast to compare with, must equal
 * modeling/lab/tests/golden/api-input.json, which modeling/lab/tests/test_contract.py validates with the lab's own
 * schema and calibrates. A change to the input on either side then fails one of the two. To regenerate it after an
 * intended change: TOWNWISE_UPDATE_LAB_GOLDEN=1 npm test -w @townwise/api -- test/lab-input.test.ts
 */
describe('the input the API builds, against the lab', () => {
  const GOLDEN = new URL('../../modeling/lab/tests/golden/api-input.json', import.meta.url);

  function apiInput(): LabInput {
    const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();
    const days = eachDay('2024-09-02', '2026-05-31')
      .filter((date) => date !== '2025-08-12' && date !== '2025-08-13')
      .map((date, index) => day(date, ['2025-03-18', '2025-11-04'].includes(date) ? 0 : 40 + weekday(date) * 6 + (index % 13)));
    const notes = [
      note({ kind: 'closure', startDate: '2025-08-12', endDate: '2025-08-13', effect: 'closed' }),
      note({ kind: 'private_event', startDate: '2025-10-17', effect: 'more_guests' }),
      note({ kind: 'private_event', startDate: '2026-02-14', effect: 'closed' }),
      note({ kind: 'closure', startDate: '2026-07-04', effect: 'closed' }),
    ];
    const run = { id: 'd4'.repeat(12), dataThrough: '2026-01-31' } as ForecastRunRecord;
    const forecastDays = eachDay('2026-02-01', '2026-05-31');
    const rows: ForecastRow[] = forecastDays.map((date) => {
      const mid = 45 + weekday(date) * 6;
      return { runId: run.id, span: 'day', from: date, to: date, status: 'open', low: mid - 9, mid, high: mid + 11, baseline: mid, openDays: null, reasons: [] };
    });
    for (const monday of forecastDays.filter((date) => weekday(date) === 1 && date <= '2026-05-25')) {
      const week = eachDay(monday, utcPlus(monday, 6));
      const mid = week.reduce((sum, date) => sum + 45 + weekday(date) * 6, 0);
      rows.push({
        runId: run.id, span: 'week', from: monday, to: utcPlus(monday, 6), status: null, low: mid - 40, mid, high: mid + 45, baseline: null,
        openDays: 7, reasons: [],
      });
    }
    const input = labInputOf({
      calibration: { id: 'ab'.repeat(12), regimeStart: '2026-01-05' }, location: HANOVER,
      days: [...days, day('2026-06-02', 61)], notes, rules: [], today: '2026-06-01', champion: { run, rows },
    });
    if (input === null) throw new Error('no input');
    return input;
  }

  function utcPlus(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  }

  it('matches the golden file the lab validates and calibrates', () => {
    const input = apiInput();
    expect(labInputSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({ today: '2026-06-01', dataThrough: '2026-05-31', regimeStart: '2026-01-05' });
    expect(daysBetween(input.days[0]?.date ?? '', input.dataThrough)).toBe(636);
    const text = `${JSON.stringify(input, null, 1)}\n`;
    if (process.env.TOWNWISE_UPDATE_LAB_GOLDEN === '1') writeFileSync(GOLDEN, text);
    expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
  });
});
