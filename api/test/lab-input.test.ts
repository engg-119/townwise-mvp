// The forecast lab's input (pure, townwise.lab-input/3): every date from the first day with guests to dataThrough + 400,
// the town's last researched term day (D52), the term and week of term from Hanover's calendar, the notes as three flags, the town's event groups, the town calendar's
// entries without a title or URL, and the current published run with its engine. The numbers are synthetic. The last
// test holds the API's input to the lab's own validator through a golden file.
import { readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { daysBetween } from '../src/dates.ts';
import { canonicalSha256, eachDay } from '../src/forecasts/file.ts';
import {
  HORIZON_DAYS, LAB_MODEL_VERSION, labInputFingerprint, labInputOf, labInputSchema, termsThroughOf, type LabInput,
} from '../src/lab/input.ts';
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
    detail: 'sentinel-note-detail', title: null, startTime: null, endTime: null, createdBy: 'c3'.repeat(12), byStaff: false, source: null, fromEvent: null, createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
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
  it('covers every date from the first day with guests to dataThrough + 400 with no gaps (D52)', () => {
    const days = [
      day('2024-12-30', null), day('2024-12-31', 0),
      ...history('2025-01-02', '2026-05-31', ['2025-02-10', '2025-04-15']),
      day('2025-04-15', 0),
      day('2026-06-01', 0), day('2026-06-02', null),
    ];
    const input = inputOf(days);
    expect(input).toMatchObject({
      schema: 'townwise.lab-input/3', calibrationId: CALIBRATION.id, metric: 'guests', today: TODAY, dataThrough: '2026-05-31',
      horizonDays: 400, termsThrough: '2028-06-06', regimeStart: null, champion: null,
    });
    expect(input.days[0]?.date).toBe('2025-01-02');
    expect(input.days.at(-1)?.date).toBe('2027-07-05');
    expect(daysBetween('2026-05-31', '2027-07-05')).toBe(HORIZON_DAYS);
    expect(input.days).toHaveLength(daysBetween('2025-01-02', '2027-07-05') + 1);
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

  it('a yearly season across the new year (D46) closes its months and days on history days with no guests, and no others', () => {
    const holidays: ScheduledRule = {
      id: '8'.repeat(24),
      schedule: {
        kind: 'closure', startDate: '2025-06-01', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
        season: { repeat: 'yearly', from: '11-25', to: '01-05' },
      },
    };
    const days = history('2025-01-02', '2026-05-31', ['2025-12-31', '2026-01-03', '2026-01-07']);
    const input = inputOf(days, [], null, [holidays]);
    expect(['2025-12-31', '2026-01-03'].map((date) => dayOf(input, date).closed)).toEqual([true, true]);
    // Outside the season, with no row, and inside it with real guests: not closed by the rule.
    expect(dayOf(input, '2026-01-07').closed).toBe(false);
    expect(dayOf(input, '2026-01-02')).toMatchObject({ closed: false, guests: expect.any(Number) as number });
    // After dataThrough a closure is left to the forecast read, as any closure is (estimates.int.test.ts pins the read).
    expect([dayOf(input, '2026-11-24').closed, dayOf(input, '2026-11-25').closed]).toEqual([false, false]);
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
    // Federal holidays are not events: a day's events never name one (the calendar does, next test).
    for (const holiday of ['2025-07-04', '2025-11-27', '2025-12-25', '2026-01-01']) expect(dayOf(input, holiday).events).toEqual([]);
    expect(JSON.stringify(input.days)).not.toContain('us:');
    const text = JSON.stringify(input);
    for (const absent of ['sentinel-note-detail', 'Hanover', 'Winter Carnival', 'Commencement', 'Thanksgiving', 'Fall term', 'https:', 'opm.gov']) {
      expect(text).not.toContain(absent);
    }
  });

  it('carries the town calendar over the input’s days as ids, groups, kinds, dates and confidence, never a title or URL', () => {
    const input = inputOf(history('2025-01-02', '2026-05-31'));
    const first = input.days[0]?.date ?? '';
    const last = input.days.at(-1)?.date ?? '';
    expect(input.calendar.length).toBeGreaterThan(20);
    for (const entry of input.calendar) {
      expect(Object.keys(entry).sort()).toEqual(['confidence', 'end', 'group', 'id', 'kind', 'start']);
      expect(entry.start <= last && entry.end >= first).toBe(true);
    }
    // A federal holiday, a term and a researched event, each by id and group.
    expect(input.calendar).toContainEqual({
      id: 'us:thanksgiving:2025', group: 'us:thanksgiving', kind: 'holiday', start: '2025-11-27', end: '2025-11-27', confidence: null,
    });
    expect(input.calendar.some((entry) => entry.kind === 'term' && entry.start <= '2025-10-01' && entry.end >= '2025-10-01')).toBe(true);
    expect(input.calendar.filter((entry) => entry.group === 'hanover-nh:home-football').length).toBeGreaterThan(3);
    // Sorted by start, then id, as townEvents sorts.
    const keys = input.calendar.map((entry) => `${entry.start}|${entry.id}`);
    expect(keys).toEqual([...keys].sort());
    // A title or URL key would be refused by the schema (and by the lab's validator).
    const [entry] = input.calendar;
    if (entry === undefined) return expect.unreachable('a calendar entry');
    for (const extra of [{ title: 'Thanksgiving Day' }, { url: 'https://example.test' }]) {
      expect(labInputSchema.safeParse({ ...input, calendar: [{ ...entry, ...extra }] }).success).toBe(false);
    }
  });

  it('a town outside the researched twelve gets the federal holidays only in its calendar', () => {
    const input = labInputOf({
      calibration: CALIBRATION, location: { town: { townId: null, name: 'Elsewhere', state: 'VT' } },
      days: history('2025-01-02', '2026-05-31'), notes: [], rules: [], today: TODAY, champion: null,
    });
    // 2025's after Jan 2 (ten), 2026's eleven and 2027's through Jul 5, its Independence Day observed (six).
    expect(input?.calendar).toHaveLength(27);
    expect(input?.calendar.every((entry) => entry.kind === 'holiday' && entry.id.startsWith('us:'))).toBe(true);
  });

  it('includes the current champion run rows, its engine from the run’s model family, its recorded weekday bias, and null without one', () => {
    const run = { id: 'd4'.repeat(12), dataThrough: '2026-03-31', model: { family: 'hybrid_linear_xgboost' } } as ForecastRunRecord;
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
    const input = inputOf(history('2025-01-02', '2026-05-31'), [], { run, rows, recordedWeekdayBiasMeanAbs: 0.031 });
    expect(input.champion).toEqual({
      runId: run.id, engine: 'model', recordedWeekdayBiasMeanAbs: 0.031, dataThrough: '2026-03-31',
      days: [
        { date: '2026-04-01', status: 'open', low: 1, mid: 2, high: 3 },
        { date: '2026-04-02', status: 'closed', low: null, mid: null, high: null },
        { date: '2026-04-03', status: 'booked', low: null, mid: null, high: null },
      ],
      weeks: [{ from: '2026-03-30', to: '2026-04-05', openDays: 4, low: 10, mid: 12, high: 14 }],
    });
    expect(inputOf(history('2025-01-02', '2026-05-31')).champion).toBeNull();
    // A baseline run (D42) is the baseline engine; every other family, an import's included, is the model.
    const baseline = { ...run, model: { ...run.model, family: 'seasonal_baseline' } } as ForecastRunRecord;
    expect(inputOf(history('2025-01-02', '2026-05-31'), [], { run: baseline, rows, recordedWeekdayBiasMeanAbs: 0.031 }).champion?.engine).toBe('baseline');
    // An import has no recorded backtest: null, and the lab then has no weekday bias to hold the model to (as the gate).
    const imported = { ...run, model: { ...run.model, family: 'linear_median' } } as ForecastRunRecord;
    expect(inputOf(history('2025-01-02', '2026-05-31'), [], { run: imported, rows, recordedWeekdayBiasMeanAbs: null }).champion)
      .toMatchObject({ engine: 'model', recordedWeekdayBiasMeanAbs: null });
    expect(labInputSchema.safeParse({ ...input, champion: { ...input.champion, recordedWeekdayBiasMeanAbs: -0.01 } }).success).toBe(false);
  });

  it('labInputSchema refuses versions 1 and 2, as the lab does', () => {
    const input = inputOf(history('2025-01-02', '2026-05-31'));
    expect(labInputSchema.safeParse({ ...input, schema: 'townwise.lab-input/1' }).success).toBe(false);
    expect(labInputSchema.safeParse({ ...input, calendar: undefined }).success).toBe(false);
    // Version 2: 182 future days and no termsThrough
    const withoutTerms = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'termsThrough'));
    expect(labInputSchema.safeParse({ ...withoutTerms, schema: 'townwise.lab-input/2', horizonDays: 182 }).success).toBe(false);
    expect(labInputSchema.safeParse({ ...input, horizonDays: 182 }).success).toBe(false);
    expect(labInputSchema.safeParse(withoutTerms).success).toBe(false);
    expect(labInputSchema.safeParse({ ...input, termsThrough: '2028-02-30' }).success).toBe(false);
  });

  it('names the town’s last researched term day as termsThrough (D52), and null for a town with no terms', () => {
    // Hanover's spring 2028 finals, however short the history: the term day is the town's, not the input's
    expect(inputOf(history('2025-01-02', '2026-05-31')).termsThrough).toBe('2028-06-06');
    expect(termsThroughOf('hanover-nh')).toBe('2028-06-06');
    // A researched town with key dates but no term entries, and a town outside the researched twelve
    const towns: LocationRecord['town'][] = [{ townId: 'amherst-ma', name: 'Amherst', state: 'MA' }, { townId: null, name: 'Elsewhere', state: 'VT' }];
    for (const town of towns) {
      const input = labInputOf({
        calibration: CALIBRATION, location: { town }, days: history('2025-01-02', '2026-05-31'), notes: [], rules: [], today: TODAY,
        champion: null,
      });
      expect(input?.termsThrough).toBeNull();
      expect(labInputSchema.safeParse(input).success).toBe(true);
    }
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
    expect(input.days.at(-1)?.date).toBe('2027-07-07');
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

describe('labInputFingerprint (D42, the weekly refresh’s “changed since its last fit”)', () => {
  const days = history('2025-01-02', '2026-05-31');
  const base = inputOf(days);
  const fingerprint = labInputFingerprint(base);
  const run = { id: 'd4'.repeat(12), dataThrough: '2026-03-31', model: { family: 'hybrid_linear_xgboost' } } as ForecastRunRecord;
  const championRow: ForecastRow = {
    runId: run.id, span: 'day', from: '2026-04-01', to: '2026-04-01', status: 'open', low: 1, mid: 2, high: 3, baseline: 2, openDays: null, reasons: [],
  };

  it('is a sha256 of the input without its calibration id, today and current run, with the schema and LAB_MODEL_VERSION', () => {
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toBe(canonicalSha256(base));
    const { schema, metric, dataThrough, horizonDays, termsThrough, regimeStart, calendar } = base;
    expect(fingerprint).toBe(canonicalSha256({
      modelVersion: LAB_MODEL_VERSION, input: { schema, metric, dataThrough, horizonDays, termsThrough, regimeStart, days: base.days, calendar },
    }));
    // A newly researched term moves termsThrough, and so the fingerprint: the town's locations refit (D52)
    expect(labInputFingerprint({ ...base, termsThrough: '2028-11-22' })).not.toBe(fingerprint);
  });

  it('is unchanged when only the calibration, today or the current run changes', () => {
    expect(labInputFingerprint({ ...base, calibrationId: 'e5'.repeat(12) })).toBe(fingerprint);
    expect(labInputFingerprint({ ...base, today: '2026-06-09' })).toBe(fingerprint);
    expect(labInputFingerprint(inputOf(days, [], { run, rows: [championRow], recordedWeekdayBiasMeanAbs: 0.04 }))).toBe(fingerprint);
  });

  it('changes with a rule, a note, a day, a deleted day, a pattern change date or a model version bump', () => {
    const rule: ScheduledRule = {
      id: '1'.repeat(24),
      // A party every Saturday with no guest count: privateEvent on history and future Saturdays alike
      schedule: { kind: 'private_event', startDate: '2026-01-03', endDate: null, weekdays: [6], effect: 'more_guests', expectedGuests: null, startTime: null, endTime: null },
    };
    const changed = [
      inputOf(days, [], null, [rule]),
      inputOf(days, [note({ kind: 'private_event', startDate: '2026-04-11' })]),
      inputOf([...days, day('2026-06-01', 52)]),
      inputOf(days.filter((each) => each.date !== '2026-03-14')),
      inputOf(days.map((each) => (each.date === '2026-03-14' ? { ...each, guests: (each.guests ?? 0) + 1 } : each))),
      { ...base, regimeStart: '2026-01-05' },
    ];
    for (const input of changed) expect(labInputFingerprint(input)).not.toBe(fingerprint);
    expect(labInputFingerprint(base, 'v11')).not.toBe(fingerprint);
    expect(labInputFingerprint(base, LAB_MODEL_VERSION)).toBe(fingerprint);
  });
});

describe('confirmed booking labels (learn-from-calendar-bookings, D58)', () => {
  const days = history('2025-01-02', '2026-05-31');
  const stored = (date: string): number | null => days.find((each) => each.date === date)?.guests ?? null;
  const withLabels = (
    bookings: Parameters<typeof labInputOf>[0]['bookings'], notes: readonly NoteRecord[] = [], sales: readonly SalesDay[] = days,
  ): LabInput => {
    const input = labInputOf({
      calibration: CALIBRATION, location: HANOVER, days: sales, notes, rules: [], today: TODAY, champion: null, ...(bookings === undefined ? {} : { bookings }),
    });
    if (input === null) throw new Error('no input');
    return labInputSchema.parse(input);
  };

  it('a buyout books a past day and a party marks it a private event, its guests unchanged; none means as before', () => {
    const input = withLabels([
      { startDate: '2026-05-29', endDate: '2026-05-29', booking: 'buyout' },
      { startDate: '2026-05-30', endDate: '2026-05-30', booking: 'party' },
      { startDate: '2026-05-15', endDate: '2026-05-16', booking: 'party' },
    ]);
    expect(dayOf(input, '2026-05-29')).toMatchObject({ booked: true, privateEvent: false, closed: false, guests: stored('2026-05-29') });
    expect(dayOf(input, '2026-05-30')).toMatchObject({ booked: false, privateEvent: true, closed: false, guests: stored('2026-05-30') });
    expect([dayOf(input, '2026-05-15').privateEvent, dayOf(input, '2026-05-16').privateEvent, dayOf(input, '2026-05-17').privateEvent]).toEqual([true, true, false]);
    expect(withLabels([])).toEqual(withLabels(undefined));
    expect(withLabels(undefined)).toEqual(inputOf(days));
  });

  it('a private-event or closure note on the day decides: a counted party is not counted twice, and a closure is not booked', () => {
    const notes = [
      note({ kind: 'private_event', startDate: '2026-05-23', effect: 'more_guests', expectedGuests: 20 }),
      note({ kind: 'closure', startDate: '2026-05-22', effect: 'closed' }),
    ];
    const input = withLabels([
      { startDate: '2026-05-23', endDate: '2026-05-23', booking: 'party' },
      { startDate: '2026-05-22', endDate: '2026-05-22', booking: 'buyout' },
    ], notes);
    expect(dayOf(input, '2026-05-23')).toMatchObject({ privateEvent: false, booked: false, guests: (stored('2026-05-23') ?? 0) - 20 });
    expect(dayOf(input, '2026-05-22')).toMatchObject({ closed: true, booked: false });
  });

  it('never changes a likely-closed day: a party on a near-empty Monday stays closed with no guests', () => {
    const sales = days.map((each) => (each.date === '2026-04-06' ? day(each.date, 1) : each));
    const input = withLabels([{ startDate: '2026-04-06', endDate: '2026-04-06', booking: 'party' }], [], sales);
    expect(dayOf(input, '2026-04-06')).toMatchObject({ closed: true, guests: null });
    expect(dayOf(withLabels(undefined, [], sales), '2026-04-06')).toMatchObject({ closed: true, guests: null });
  });

  it('sets nothing after dataThrough: an upcoming booking reaches the forecast as its note', () => {
    const input = withLabels([
      { startDate: '2026-06-10', endDate: '2026-06-10', booking: 'party' }, { startDate: '2026-06-12', endDate: '2026-06-12', booking: 'buyout' },
      // A booking running across dataThrough sets only its history days.
      { startDate: '2026-05-31', endDate: '2026-06-01', booking: 'buyout' },
    ]);
    expect(input.dataThrough).toBe('2026-05-31');
    for (const date of ['2026-06-10', '2026-06-12', '2026-06-01']) expect(dayOf(input, date)).toMatchObject({ privateEvent: false, booked: false });
    expect(dayOf(input, '2026-05-31')).toMatchObject({ booked: true });
  });

  it('changes the fingerprint with a confirmed label on a history day, and not with one after dataThrough or none', () => {
    const fingerprint = labInputFingerprint(withLabels(undefined));
    expect(labInputFingerprint(withLabels([{ startDate: '2026-05-30', endDate: '2026-05-30', booking: 'party' }]))).not.toBe(fingerprint);
    expect(labInputFingerprint(withLabels([{ startDate: '2026-06-10', endDate: '2026-06-10', booking: 'party' }]))).toBe(fingerprint);
    expect(labInputFingerprint(withLabels([]))).toBe(fingerprint);
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
    const run = { id: 'd4'.repeat(12), dataThrough: '2026-01-31', model: { family: 'hybrid_linear_xgboost' } } as ForecastRunRecord;
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
      days: [...days, day('2026-06-02', 61)], notes, rules: [], today: '2026-06-01', champion: { run, rows, recordedWeekdayBiasMeanAbs: 0.04 },
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

  /**
   * Hanover's days and calendar as labInputOf builds them from 2024-06-12 to 2028-07-15 (four years of history and the
   * 400 days after a cut three years in), for the lab's outlook coverage check (modeling/lab/tests/test_outlook_coverage.py,
   * D52 decision 6): each day's term, week of term and event groups, and the calendar entries starting by the last day.
   * The guests are left out: the check makes its own.
   */
  it('writes the Hanover days the lab’s outlook coverage check reads (D52)', () => {
    const HANOVER_GOLDEN = new URL('../../modeling/lab/tests/golden/hanover-calendar.json', import.meta.url);
    const [first, last] = ['2024-06-12', '2028-07-15'];
    const input = labInputOf({
      calibration: { id: 'ab'.repeat(12), regimeStart: null }, location: HANOVER,
      days: eachDay(first, last).map((date) => day(date, 50)), notes: [], rules: [], today: last, champion: null,
    });
    if (input === null) throw new Error('no input');
    const days = input.days.filter((each) => each.date <= last)
      .map(({ date, term, weekOfTerm, events }) => ({ date, term, weekOfTerm, events }));
    const calendar = input.calendar.filter((entry) => entry.start <= last);
    expect(days.map((each) => each.date)).toEqual(eachDay(first, last));
    expect(new Set(days.map((each) => each.term))).toEqual(new Set(['interim', 'fall', 'winter', 'spring', 'summer']));
    const lines = (rows: readonly unknown[]): string => rows.map((row) => JSON.stringify(row)).join(',\n');
    const text = `{"calendar": [\n${lines(calendar)}\n],\n"days": [\n${lines(days)}\n]}\n`;
    if (process.env.TOWNWISE_UPDATE_LAB_GOLDEN === '1') writeFileSync(HANOVER_GOLDEN, text);
    expect(readFileSync(HANOVER_GOLDEN, 'utf8')).toBe(text);
  });
});
