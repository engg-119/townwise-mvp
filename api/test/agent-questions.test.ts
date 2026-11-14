// TownwiseAI's rule-based questions (src/agent/questions.ts, spec 10.12): weekday closures at 60%, gaps grouped into
// runs, likely-closed days (D32), each with the numbers behind it, asked only about usually busy days, days a note or
// an earlier answer explains left out, at most 5 in a fixed order, over the last 365 days of coverage. Synthetic days only.
import { describe, expect, it } from 'vitest';

import {
  answerOfNote, BUSY_OPEN_WEEKS, BUSY_TYPICAL_GUESTS, closureNoteOf, isClosure, MAX_QUESTIONS, noteCovers, noteFor,
  OPEN_DAY_DETAIL, parseQuestionId, QUESTION_ANSWERS, questionId, questionsFor, questionWindow, type AskedQuestion,
  type QuestionInput,
} from '../src/agent/questions.ts';
import { summaryOf } from '../src/audit.ts';
import { closureOf, typicalGuests } from '../src/closed-days.ts';
import { readNoteContent } from '../src/handlers/notes.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function plus(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = plus(day, 1)) out.push(day);
  return out;
}

function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

/**
 * A row for every day from `from` to `to`, except the days `missing` leaves out, with `guests(day)` guests (100 unless
 * given) and no net sales.
 */
function input(
  from: string, to: string, missing: (day: string) => boolean, extra: Partial<QuestionInput> = {},
  guests: (day: string) => number = () => 100,
): QuestionInput {
  const days: SalesDay[] = range(from, to).filter((day) => !missing(day)).map((date) => ({ date, guests: guests(date), netSalesCents: null }));
  return { coverage: { firstDate: from, lastDate: to }, days, notes: [], answered: [], ...extra };
}

function note(over: Partial<NoteContent>): NoteContent {
  return {
    kind: 'closure', startDate: '2026-01-01', endDate: '2026-01-01', weekdays: null, effect: 'closed', expectedGuests: null,
    detail: null, startTime: null, endTime: null, ...over,
  };
}

// 2026-01-05 is a Monday; ten weeks run to Sunday 2026-03-15. Coverage from FROM: the days before it hold no data.
const FROM = '2026-01-05';
const TO = '2026-03-15';
const mondays = range(FROM, TO).filter((day) => weekday(day) === 1);

/** One gap question with its weekday's typical guests. */
function gap(from: string, to: string, low = 100, high = low) {
  return { id: `gap_${from}_${to}`, kind: 'gap', from, to, dayCount: range(from, to).length, typicalGuestsLow: low, typicalGuestsHigh: high };
}

describe('the answers', () => {
  it('are closed, open, not sure and something else', () => {
    expect(QUESTION_ANSWERS).toEqual(['closed', 'open', 'not_sure', 'other']);
  });
});

describe('weekday closures', () => {
  it('asks about a weekday with no sales on at least 60% of its days in the window, and not below', () => {
    expect(mondays).toHaveLength(10);
    const six = new Set(mondays.slice(1, 7));
    expect(questionsFor(input(FROM, TO, (day) => six.has(day)))).toEqual([{
      id: `weekday_1_${FROM}_${TO}`, kind: 'weekday', weekday: 1, from: FROM, to: TO, noSalesCount: 6, weekdayCount: 10,
    }]);
    // Below 60% the missing Mondays are ordinary gaps instead, asked while Mondays were usually busy: the last one
    // follows only 4 Mondays with guests.
    const five = new Set(mondays.slice(5));
    expect(questionsFor(input(FROM, TO, (day) => five.has(day))).map((q) => q.id)).toEqual([
      'gap_2026-03-02_2026-03-02', 'gap_2026-02-23_2026-02-23', 'gap_2026-02-16_2026-02-16', 'gap_2026-02-09_2026-02-09',
    ]);
  });

  it('needs at least 4 of the weekday in the window', () => {
    const short = input('2026-01-04', '2026-01-25', (day) => weekday(day) === 1);
    expect(range('2026-01-04', '2026-01-25').filter((day) => weekday(day) === 1)).toHaveLength(3);
    // No weekday question, and three weeks are too little history for a gap.
    expect(questionsFor(short)).toEqual([]);
  });

  it('a closure note on the weekday explains it; a note that is not a closure does not', () => {
    const closedMondays = (day: string) => weekday(day) === 1;
    const covered = input(FROM, TO, closedMondays, { notes: [note({ startDate: FROM, endDate: TO, weekdays: [1] })] });
    expect(questionsFor(covered)).toEqual([]);
    const party = note({ kind: 'private_event', effect: 'more_guests', startDate: FROM, endDate: TO, weekdays: [1] });
    expect(questionsFor(input(FROM, TO, closedMondays, { notes: [party] })).map((q) => q.kind)).toEqual(['weekday']);
  });

  it('counts a stored day with neither guests nor net sales as a day with no sales', () => {
    const base = input(FROM, TO, (day) => weekday(day) === 2);
    const blanks: SalesDay[] = range(FROM, TO).filter((day) => weekday(day) === 2).map((date) => ({ date, guests: null, netSalesCents: null }));
    expect(questionsFor({ ...base, days: [...base.days, ...blanks] }).map((q) => q.id)).toEqual([`weekday_2_${FROM}_${TO}`]);
  });

  it('counts only weeks with sales on another day, from the first day with sales in the window', () => {
    // An older upload and the latest two months: the window holds no data before 2025-11-01, which no question asks about.
    const both = new Set([...range('2024-11-01', '2024-12-31'), ...range('2025-11-01', '2025-12-31')]);
    const window = questionWindow({ firstDate: '2024-11-01', lastDate: '2025-12-31' });
    expect(window).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    const days = input('2024-11-01', '2025-12-31', (day) => !both.has(day)).days.filter((day) => day.date >= (window?.from ?? ''));
    expect(questionsFor({ coverage: { firstDate: '2024-11-01', lastDate: '2025-12-31' }, days, notes: [], answered: [] })).toEqual([]);
    // Eight months missing whole: one gap question, and no weekday looks closed. Its first four weeks still follow at
    // least 5 same weekdays with guests, so it is asked over its whole span, with their typical guests.
    const hole = (day: string) => day >= '2025-03-01' && day <= '2025-10-31';
    expect(questionsFor(input('2025-01-01', '2025-12-31', hole))).toEqual([gap('2025-03-01', '2025-10-31')]);
    expect(gap('2025-03-01', '2025-10-31').dayCount).toBe(245);
    // Closed on Mondays through the same hole: the Mondays of the weeks with data, from the first day with sales.
    const closedToo = input('2025-01-01', '2025-12-31', (day) => hole(day) || weekday(day) === 1);
    const asked = questionsFor(closedToo);
    expect(asked[0]).toEqual({
      id: 'weekday_1_2025-01-01_2025-12-31', kind: 'weekday', weekday: 1, from: '2025-01-01', to: '2025-12-31',
      noSalesCount: 18, weekdayCount: 18,
    });
    // The gap is trimmed to the days that are not closed Mondays.
    expect(asked.slice(1).map((q) => q.id)).toEqual(['gap_2025-03-01_2025-10-31']);
  });

  it('a weekday question starts at the first day with sales in the window', () => {
    const late = '2026-01-14';
    const days = input(FROM, TO, (day) => day < late || weekday(day) === 1).days;
    expect(questionsFor({ coverage: { firstDate: late, lastDate: TO }, days, notes: [], answered: [] })).toEqual([{
      id: `weekday_1_${late}_${TO}`, kind: 'weekday', weekday: 1, from: late, to: TO, noSalesCount: 8, weekdayCount: 8,
    }]);
    // The same days with the coverage reaching back further: the window starts earlier, the question does not.
    expect(questionsFor({ coverage: { firstDate: '2025-06-01', lastDate: TO }, days, notes: [], answered: [] }).map((q) => q.id))
      .toEqual([`weekday_1_${late}_${TO}`]);
  });
});

describe('gaps', () => {
  it('groups consecutive days with no sales into one question each', () => {
    const missing = new Set(['2026-02-10', '2026-02-11', '2026-02-12', '2026-03-01']);
    expect(questionsFor(input(FROM, TO, (day) => missing.has(day)))).toEqual([
      gap('2026-03-01', '2026-03-01'), gap('2026-02-10', '2026-02-12'),
    ]);
  });

  it('leaves out days any note covers, splitting a run there', () => {
    const missing = new Set(range('2026-02-09', '2026-02-15'));
    const party = note({ kind: 'private_event', effect: 'unknown', startDate: '2026-02-11', endDate: '2026-02-12' });
    expect(questionsFor(input(FROM, TO, (day) => missing.has(day), { notes: [party] })).map((q) => q.id)).toEqual([
      'gap_2026-02-13_2026-02-15', 'gap_2026-02-09_2026-02-10',
    ]);
    const all = note({ startDate: '2026-02-01', endDate: '2026-02-28' });
    expect(questionsFor(input(FROM, TO, (day) => missing.has(day), { notes: [all] }))).toEqual([]);
  });

  it('a weekday the location is usually closed on bridges a gap but never starts or ends one', () => {
    const closed = new Set(mondays);
    // Sunday to Tuesday around a closed Monday, and a closed Monday alone.
    const missing = (day: string) => closed.has(day) || day === '2026-02-15' || day === '2026-02-17';
    const answered = [`weekday_1_${FROM}_${TO}`];
    expect(questionsFor(input(FROM, TO, missing, { answered }))).toEqual([gap('2026-02-15', '2026-02-17')]);
  });

  it('does not ask about a run the window cuts off before the first day with sales', () => {
    // 400 days of coverage: the window starts 364 days before the last day, on a day with no sales.
    const first = '2025-02-01';
    const last = '2026-03-07';
    const window = questionWindow({ firstDate: first, lastDate: last });
    expect(window).toEqual({ from: plus(last, -364), to: last });
    const missing = new Set([...range(plus(last, -370), plus(last, -360)), '2026-03-01']);
    const days = input(first, last, (day) => missing.has(day)).days.filter((day) => day.date >= (window?.from ?? ''));
    expect(questionsFor({ coverage: { firstDate: first, lastDate: last }, days, notes: [], answered: [] }).map((q) => q.id))
      .toEqual(['gap_2026-03-01_2026-03-01']);
  });
});

describe('the evidence, and asking only about usually busy days', () => {
  it('a one-day gap carries its weekday’s typical guests', () => {
    expect(questionsFor(input(FROM, TO, (day) => day === '2026-03-09'))).toEqual([{
      id: 'gap_2026-03-09_2026-03-09', kind: 'gap', from: '2026-03-09', to: '2026-03-09', dayCount: 1,
      typicalGuestsLow: 100, typicalGuestsHigh: 100,
    }]);
  });

  it('asks about a day only when its weekday had guests on at least 5 of the 8 same weekdays before it', () => {
    expect(BUSY_OPEN_WEEKS).toBe(5);
    // Four Mondays with guests come before 2026-02-02, five before 2026-02-09.
    expect(questionsFor(input(FROM, TO, (day) => day === '2026-02-02'))).toEqual([]);
    expect(questionsFor(input(FROM, TO, (day) => day === '2026-02-09')).map((q) => q.id)).toEqual(['gap_2026-02-09_2026-02-09']);
  });

  /** Guests on the 8 Mondays before 2026-03-09 (mondays[1] to mondays[8]); 100 on every other day. */
  const mondaysBefore = (values: readonly number[]) => (day: string): number => {
    const index = mondays.indexOf(day);
    return index >= 1 && index <= 8 ? values[index - 1] ?? 100 : 100;
  };
  const lastMonday = (day: string): boolean => day === '2026-03-09';

  it('and only when its typical guests are at least 10, compared before rounding', () => {
    expect(BUSY_TYPICAL_GUESTS).toBe(10);
    // A median of 9.5 is under 10, though it rounds to 10.
    expect(questionsFor(input(FROM, TO, lastMonday, {}, mondaysBefore([9, 9, 9, 9, 10, 10, 10, 10])))).toEqual([]);
    expect(questionsFor(input(FROM, TO, lastMonday, {}, mondaysBefore([10, 10, 10, 10, 10, 10, 10, 10]))))
      .toEqual([gap('2026-03-09', '2026-03-09', 10)]);
  });

  it('sends the typical guests rounded to a whole guest', () => {
    expect(questionsFor(input(FROM, TO, lastMonday, {}, mondaysBefore([94, 94, 94, 94, 95, 95, 95, 95]))))
      .toEqual([gap('2026-03-09', '2026-03-09', 95)]);
  });

  it('a gap’s low and high range over its usually busy days only, and its dates are those of the whole run', () => {
    // From Monday 2025-06-02: no Monday in 2025 has sales, so Monday is usually closed, though the 8 Mondays before
    // 2026-03-09 had 500 guests each. Sundays have 80 guests, Tuesdays 120 and Wednesdays 5 (never usually busy).
    const missing = (day: string) => (weekday(day) === 1 && day < '2026-01-01') || (day >= '2026-03-08' && day <= '2026-03-11');
    const guests = (day: string) => [80, 500, 120, 5, 100, 100, 100][weekday(day)] ?? 100;
    // The first day with sales is Tuesday 2025-06-03.
    expect(questionsFor(input('2025-06-02', TO, missing, {}, guests))).toEqual([
      { id: `weekday_1_2025-06-03_${TO}`, kind: 'weekday', weekday: 1, from: '2025-06-03', to: TO, noSalesCount: 31, weekdayCount: 40 },
      // Sunday 2026-03-08 to Wednesday 2026-03-11: the bridged Monday (500) and the quiet Wednesday (5) are not in the
      // range, and the run still ends on that Wednesday.
      gap('2026-03-08', '2026-03-11', 80, 120),
    ]);
  });

  it('asks about a run when at least one of its days is usually busy, over the whole run', () => {
    // Wednesday 2026-02-04 to Sunday 2026-02-08 each follow only 4 same weekdays with guests; Monday 2026-02-09 follows 5.
    expect(questionsFor(input(FROM, TO, (day) => day >= '2026-02-04' && day <= '2026-02-08'))).toEqual([]);
    expect(questionsFor(input(FROM, TO, (day) => day >= '2026-02-05' && day <= '2026-02-09'))).toEqual([gap('2026-02-05', '2026-02-09')]);
  });

  it('reads the 56 days before the window for typical guests and open weeks, and never asks about a day before it', () => {
    const first = '2025-01-01';
    expect(questionWindow({ firstDate: first, lastDate: TO })).toEqual({ from: '2025-03-16', to: TO });
    // Monday 2025-03-17, the window's second day, follows Mondays before the window only; Monday 2025-03-03 is before it.
    const all = input(first, TO, (day) => day === '2025-03-03' || day === '2025-03-17');
    const read = all.days.filter((day) => day.date >= plus('2025-03-16', -56));
    expect(questionsFor({ ...all, days: read })).toEqual([gap('2025-03-17', '2025-03-17')]);
    // Without those days 2025-03-17 has no history, so it is not asked.
    expect(questionsFor({ ...all, days: read.filter((day) => day.date >= '2025-03-16') })).toEqual([]);
  });

  it('asks a location with no guest counts weekday questions only', () => {
    const netOnly = (base: QuestionInput): QuestionInput => ({
      ...base, days: base.days.map((day) => ({ ...day, guests: null, netSalesCents: 150_000 })),
    });
    expect(questionsFor(netOnly(input(FROM, TO, lastMonday)))).toEqual([]);
    expect(questionsFor(netOnly(input(FROM, TO, (day) => weekday(day) === 2))).map((q) => q.id)).toEqual([`weekday_2_${FROM}_${TO}`]);
  });
});

describe('likely-closed days (D32)', () => {
  const SAT = '2026-03-14';
  const LIKELY = { id: `likely_closed_${SAT}`, kind: 'likely_closed', date: SAT, guests: 1, typicalGuests: 100 };
  /** Every day from FROM to TO with 100 guests, but Saturday 2026-03-14. */
  const nearEmpty = (guests: number | null, netSalesCents: number | null = null): QuestionInput => {
    const base = input(FROM, TO, () => false);
    return { ...base, days: base.days.map((day) => (day.date === SAT ? { date: SAT, guests, netSalesCents } : day)) };
  };
  /** What D32 itself says of `date` in these days, with no note. */
  const d32 = (days: QuestionInput, date: string) => {
    const guests = new Map(days.days.map((day) => [day.date, day.guests]));
    return closureOf(days.days.find((day) => day.date === date), typicalGuests(date, (other) => guests.get(other)), []);
  };

  it('asks "were you open?" about a day with guests under a tenth of its weekday’s typical guests', () => {
    expect(questionsFor(nearEmpty(1))).toEqual([LIKELY]);
    // Exactly a tenth is not under it.
    expect(questionsFor(nearEmpty(10))).toEqual([]);
    expect(questionsFor(nearEmpty(9))).toEqual([{ ...LIKELY, guests: 9 }]);
    // Sales and no guests is likely closed too.
    expect(questionsFor(nearEmpty(0, 25_000))).toEqual([{ ...LIKELY, guests: 0 }]);
  });

  it('never asks about today as likely closed, since its upload may be partial; yesterday still is', () => {
    expect(questionsFor({ ...nearEmpty(1), today: SAT })).toEqual([]);
    expect(questionsFor({ ...nearEmpty(1), today: '2026-03-13' })).toEqual([]);
    expect(questionsFor({ ...nearEmpty(1), today: '2026-03-15' })).toEqual([LIKELY]);
  });

  it('does not ask about a day closed by its data, with no guest count, or explained', () => {
    expect(questionsFor(nearEmpty(0, 0))).toEqual([]);
    expect(questionsFor(nearEmpty(0, null))).toEqual([]);
    expect(questionsFor(nearEmpty(null, 25_000))).toEqual([]);
    const covering = [
      note({ startDate: SAT, endDate: SAT }),
      note({ kind: 'other', effect: 'fewer_guests', startDate: SAT, endDate: SAT, detail: 'Slow' }),
      note({ kind: 'private_event', effect: 'more_guests', startDate: '2026-03-13', endDate: SAT }),
      note({ kind: 'opening', effect: 'unknown', startDate: FROM, endDate: TO, weekdays: [6] }),
      note({ kind: 'other', effect: 'unknown', startDate: SAT, endDate: SAT, detail: 'Inventory' }),
    ];
    for (const each of covering) expect({ each, asked: questionsFor({ ...nearEmpty(1), notes: [each] }) }).toEqual({ each, asked: [] });
    // Any earlier answer that asked about the day, whatever it was: the answers' ids are all a question needs.
    for (const id of [`weekday_6_${FROM}_${TO}`, 'gap_2026-03-13_2026-03-14', `likely_closed_${SAT}`]) {
      expect({ id, asked: questionsFor({ ...nearEmpty(1), answered: [id] }) }).toEqual({ id, asked: [] });
    }
    expect(questionsFor({ ...nearEmpty(1), turnedOff: [SAT] })).toEqual([]);
  });

  it('does not ask about a day on a usually closed weekday, or a day that is not usually busy', () => {
    // From Monday 2025-06-02 with no Saturday in 2025: Saturday is usually closed, though the 8 before SAT had guests.
    const first = '2025-06-02';
    const base = input(first, TO, (day) => weekday(day) === 6 && day < '2026-01-01');
    const closedSaturdays = { ...base, days: base.days.map((day) => (day.date === SAT ? { ...day, guests: 1 } : day)) };
    expect(questionsFor(closedSaturdays).map((q) => q.id)).toEqual([`weekday_6_${first}_${TO}`]);
    // Saturday 2026-01-31 follows 3 Saturdays with guests: D32 calls it likely closed, but it is not usually busy.
    const early = input(FROM, TO, () => false, {}, (day) => (day === '2026-01-31' ? 1 : 100));
    expect(d32(early, '2026-01-31')).toBe('likely_closed');
    expect(questionsFor(early)).toEqual([]);
    // Saturdays with 8 guests: a day with sales and no guests is likely closed, but under 10 typical guests it is not asked.
    const quiet = input(FROM, TO, () => false, {}, (day) => (weekday(day) === 6 ? 8 : 100));
    const quietSat = { ...quiet, days: quiet.days.map((day) => (day.date === SAT ? { date: SAT, guests: 0, netSalesCents: 25_000 } : day)) };
    expect(d32(quietSat, SAT)).toBe('likely_closed');
    expect(questionsFor(quietSat)).toEqual([]);
  });

  it('a likely-closed day breaks a run of days with no sales, as any day with sales does', () => {
    const missing = (day: string) => day === '2026-03-13' || day === '2026-03-15';
    const days = input(FROM, TO, missing, {}, (day) => (day === SAT ? 1 : 100));
    expect(questionsFor(days).map((q) => q.id)).toEqual(['gap_2026-03-15_2026-03-15', `likely_closed_${SAT}`, 'gap_2026-03-13_2026-03-13']);
  });
});

describe('business rule schedules (D31)', () => {
  /** A rule's schedule: a note's fields but the detail, its end null for none. */
  const rule = (over: Partial<RuleSchedule>): RuleSchedule => ({
    kind: 'closure', startDate: FROM, endDate: null, weekdays: null, effect: 'closed', expectedGuests: null,
    startTime: null, endTime: null, ...over,
  });

  it('a closure schedule explains a day with no sales, its end null meaning no end', () => {
    const missing = (day: string) => day === '2026-03-09';
    expect(questionsFor(input(FROM, TO, missing)).map((q) => q.id)).toEqual(['gap_2026-03-09_2026-03-09']);
    expect(questionsFor(input(FROM, TO, missing, { rules: [rule({ weekdays: [1] })] }))).toEqual([]);
    // Any schedule whose effect is closed is a closure, whatever its kind.
    expect(questionsFor(input(FROM, TO, missing, { rules: [rule({ kind: 'other', weekdays: [1] })] }))).toEqual([]);
    // A schedule that ends before the day, or names another weekday, does not.
    expect(questionsFor(input(FROM, TO, missing, { rules: [rule({ endDate: '2026-03-08' })] })).map((q) => q.id))
      .toEqual(['gap_2026-03-09_2026-03-09']);
    expect(questionsFor(input(FROM, TO, missing, { rules: [rule({ weekdays: [2] })] })).map((q) => q.id))
      .toEqual(['gap_2026-03-09_2026-03-09']);
  });

  it('a schedule with more or fewer guests, or any other effect, leaves a day with no sales asked', () => {
    // "Busy Mondays": a Monday with no sales under it is more suspicious, not less.
    const missing = (day: string) => day === '2026-03-09';
    const schedules = [
      rule({ kind: 'other', effect: 'more_guests', weekdays: [1] }),
      rule({ kind: 'private_event', effect: 'more_guests', weekdays: [1] }),
      rule({ kind: 'other', effect: 'fewer_guests', weekdays: [1] }),
      rule({ kind: 'other', effect: 'unknown', startDate: '2026-03-09' }),
      rule({ kind: 'opening', effect: 'unknown', startDate: '2026-03-09' }),
    ];
    for (const schedule of schedules) {
      expect({ schedule, asked: questionsFor(input(FROM, TO, missing, { rules: [schedule] })) })
        .toEqual({ schedule, asked: [gap('2026-03-09', '2026-03-09')] });
    }
  });

  it('a closure schedule on the weekday explains a weekday question; one with more guests does not', () => {
    const closedMondays = (day: string) => weekday(day) === 1;
    expect(questionsFor(input(FROM, TO, closedMondays, { rules: [rule({ weekdays: [1] })] }))).toEqual([]);
    const busy = rule({ kind: 'private_event', effect: 'more_guests', weekdays: [1] });
    expect(questionsFor(input(FROM, TO, closedMondays, { rules: [busy] })).map((q) => q.kind)).toEqual(['weekday']);
  });

  it('a likely-closed day is not asked under a schedule with fewer or more guests (open) or a closure (closed), as D32 reads it', () => {
    const near = input(FROM, TO, () => false, {}, (day) => (day === '2026-03-14' ? 1 : 100));
    const row = { guests: 1, netSalesCents: null };
    expect(questionsFor(near).map((q) => q.id)).toEqual(['likely_closed_2026-03-14']);
    const cases = [
      { schedule: rule({ kind: 'other', effect: 'fewer_guests', weekdays: [6] }), d32: null, asked: [] },
      { schedule: rule({ kind: 'other', effect: 'more_guests', weekdays: [6] }), d32: null, asked: [] },
      // "Closed Saturdays", and a Saturday with 1 guest (a staff meal): the owner's own rule says it was closed.
      { schedule: rule({ weekdays: [6] }), d32: 'closed', asked: [] },
      // Any other effect says nothing about the day.
      { schedule: rule({ kind: 'other', effect: 'unknown', weekdays: [6] }), d32: 'likely_closed', asked: ['likely_closed_2026-03-14'] },
      { schedule: rule({ kind: 'opening', effect: 'unknown', startDate: '2026-03-14' }), d32: 'likely_closed', asked: ['likely_closed_2026-03-14'] },
    ];
    for (const { schedule, d32, asked } of cases) {
      expect({ schedule, d32: closureOf(row, 100, [], { rules: [schedule] }), asked: questionsFor({ ...near, rules: [schedule] }).map((q) => q.id) })
        .toEqual({ schedule, d32, asked });
    }
  });

  it('no schedules change nothing', () => {
    const both = input(FROM, TO, (day) => day === '2026-03-09', {}, (day) => (day === '2026-03-14' ? 1 : 100));
    expect(questionsFor(both).map((q) => q.id)).toEqual(['likely_closed_2026-03-14', 'gap_2026-03-09_2026-03-09']);
    expect(questionsFor({ ...both, rules: [] })).toEqual(questionsFor(both));
  });
});

describe('answered questions', () => {
  it('are never asked again, and their days are left out of every other question', () => {
    const missing = new Set(['2026-02-10', '2026-02-11']);
    const asked = questionsFor(input(FROM, TO, (day) => missing.has(day)));
    expect(asked.map((q) => q.id)).toEqual(['gap_2026-02-10_2026-02-11']);
    expect(questionsFor(input(FROM, TO, (day) => missing.has(day), { answered: ['gap_2026-02-10_2026-02-11'] }))).toEqual([]);
    // A later gap that grew around answered days asks only about the new ones.
    const grown = new Set([...missing, '2026-02-12']);
    expect(questionsFor(input(FROM, TO, (day) => grown.has(day), { answered: ['gap_2026-02-10_2026-02-11'] })).map((q) => q.id))
      .toEqual(['gap_2026-02-12_2026-02-12']);
  });

  it('an answered weekday covers its days in that window only, so the next window does not ask again soon', () => {
    const closed = (day: string) => weekday(day) === 1;
    const answered = [`weekday_1_${FROM}_${TO}`];
    // Two more weeks of data: 2 of the 11 Mondays from the first day with sales are unexplained, under 60%, and a closed
    // Monday starts no gap.
    expect(questionsFor(input(FROM, '2026-03-29', closed, { answered }))).toEqual([]);
  });
});

describe('turned-off days (D28)', () => {
  it('dates in turnedOff are explained: no gap and no weekday question counts them', () => {
    const hole = range('2026-03-01', '2026-03-03');
    const withHole = input(FROM, TO, (day) => hole.includes(day));
    expect(questionsFor(withHole).some((q) => q.kind === 'gap')).toBe(true);
    expect(questionsFor({ ...withHole, turnedOff: hole }).some((q) => q.kind === 'gap')).toBe(false);
    const closedMondays = input(FROM, TO, (day) => weekday(day) === 1);
    expect(questionsFor(closedMondays).some((q) => q.kind === 'weekday')).toBe(true);
    expect(questionsFor({ ...closedMondays, turnedOff: mondays }).some((q) => q.kind === 'weekday')).toBe(false);
  });

  it('turned-off Mondays in weeks with sales do not make Monday usually closed, so a gap never bridges one', () => {
    // A Sunday and a Tuesday with no sales around a turned-off Monday: two gaps, never one over the Monday.
    const missing = (day: string): boolean => weekday(day) === 1 || day === '2026-02-15' || day === '2026-02-17';
    const ids = questionsFor(input(FROM, TO, missing, { turnedOff: mondays })).map((q) => q.id);
    expect(ids).toEqual(['gap_2026-02-17_2026-02-17', 'gap_2026-02-15_2026-02-15']);
  });
});

describe('the cap and the order', () => {
  it('at most 5: weekday questions first, then gaps and likely-closed days together, newest first by their last day', () => {
    const missing = (day: string) => weekday(day) === 3 || weekday(day) === 5 || ['2026-02-10', '2026-02-24', '2026-03-10'].includes(day);
    const guests = (day: string) => (day === '2026-02-28' || day === '2026-03-14' ? 1 : 100);
    const weekdays = [`weekday_3_${FROM}_${TO}`, `weekday_5_${FROM}_${TO}`];
    const questions = questionsFor(input(FROM, TO, missing, {}, guests));
    expect(questions).toHaveLength(MAX_QUESTIONS);
    expect(questions.map((q) => q.id)).toEqual([
      ...weekdays, 'likely_closed_2026-03-14', 'gap_2026-03-10_2026-03-10', 'likely_closed_2026-02-28',
    ]);
    // An answered question is left out before the cap, so the next one shows.
    expect(questionsFor(input(FROM, TO, missing, { answered: ['likely_closed_2026-03-14'] }, guests)).map((q) => q.id)).toEqual([
      ...weekdays, 'gap_2026-03-10_2026-03-10', 'likely_closed_2026-02-28', 'gap_2026-02-24_2026-02-24',
    ]);
  });

  it('asks nothing of a location with no sales, or with every day present', () => {
    expect(questionsFor({ coverage: { firstDate: null, lastDate: null }, days: [], notes: [], answered: [] })).toEqual([]);
    expect(questionWindow({ firstDate: null, lastDate: null })).toBeNull();
    expect(questionsFor(input(FROM, TO, () => false))).toEqual([]);
  });
});

describe('question ids and the notes an answer saves', () => {
  const weekdayQ = { kind: 'weekday', weekday: 1, from: FROM, to: TO } as const;
  const gapQ = { kind: 'gap', from: '2026-12-24', to: '2026-12-26' } as const;
  const likelyQ = { kind: 'likely_closed', date: '2026-03-14' } as const;
  const openDay: NoteContent = {
    kind: 'other', startDate: '2026-03-14', endDate: '2026-03-14', weekdays: null, effect: 'fewer_guests', expectedGuests: null,
    detail: 'Open, with very few guests (your answer to TownwiseAI).', startTime: null, endTime: null,
  };

  it('an id round-trips to what it asks, and anything else names no question', () => {
    for (const asked of [weekdayQ, gapQ, likelyQ] satisfies AskedQuestion[]) {
      expect(parseQuestionId(questionId(asked))).toEqual(asked);
    }
    expect(questionId(likelyQ)).toBe('likely_closed_2026-03-14');
    for (const id of [
      'gap_2026-12-26_2026-12-24', 'gap_2026-02-30_2026-03-01', 'weekday_7_2026-01-05_2026-03-15', 'gap_2026-12-24',
      'weekday_1_2025-01-01_2026-01-01', 'other_2026-12-24_2026-12-26', 'likely_closed_2026-02-30',
      'likely_closed_2026-01-01_2026-01-02', 'likely_closed_', 'likely_closed_2026-3-14', 'likely_closed_x2026-03-14',
    ]) {
      expect({ id, asked: parseQuestionId(id) }).toEqual({ id, asked: null });
    }
  });

  it('a closed answer saves a closure note over the gap, the weekday over the window, or the likely-closed day', () => {
    const closure = closureNoteOf(gapQ);
    expect(closure).toEqual(note({ startDate: '2026-12-24', endDate: '2026-12-26' }));
    const weekly = closureNoteOf({ kind: 'weekday', weekday: 1, from: plus(TO, -364), to: TO });
    expect(weekly).toEqual(note({ startDate: plus(TO, -364), endDate: TO, weekdays: [1] }));
    expect(closureNoteOf(likelyQ)).toEqual(note({ startDate: '2026-03-14', endDate: '2026-03-14' }));
    for (const content of [closure, weekly, closureNoteOf(likelyQ)]) expect(readNoteContent(content, TO)).toEqual(content);
  });

  it('noteFor: closed saves the closure note on every kind; open saves the open-day note on a likely-closed question only', () => {
    for (const asked of [weekdayQ, gapQ, likelyQ]) expect(noteFor(asked, 'closed')).toEqual(closureNoteOf(asked));
    expect(OPEN_DAY_DETAIL).toBe('Open, with very few guests (your answer to TownwiseAI).');
    expect(noteFor(likelyQ, 'open')).toEqual(openDay);
    expect(readNoteContent(openDay, TO)).toEqual(openDay);
    for (const asked of [weekdayQ, gapQ, likelyQ]) {
      for (const answer of ['open', 'not_sure', 'other'] as const) {
        if (asked.kind !== 'likely_closed' || answer !== 'open') expect({ asked, answer, note: noteFor(asked, answer) }).toEqual({ asked, answer, note: null });
      }
    }
  });

  it('agrees with D32: the open-day note makes the day open and the closure note makes it closed', () => {
    const row = { guests: 1, netSalesCents: null };
    expect(closureOf(row, 100, [])).toBe('likely_closed');
    expect(closureOf(row, 100, [openDay])).toBeNull();
    expect(closureOf(row, 100, [closureNoteOf(likelyQ)])).toBe('closed');
    expect(isClosure(openDay)).toBe(false);
  });

  it('answerOfNote: the note with the row’s id decides the answer', () => {
    expect(answerOfNote(likelyQ, closureNoteOf(likelyQ))).toBe('closed');
    expect(answerOfNote(likelyQ, openDay)).toBe('open');
    for (const asked of [weekdayQ, gapQ]) {
      expect(answerOfNote(asked, closureNoteOf(asked))).toBe('closed');
      expect(answerOfNote(asked, openDay)).toBe('closed');
    }
  });

  it('noteCovers and isClosure read notes and rule schedules as before', () => {
    const schedule = { startDate: '2026-01-05', endDate: null, weekdays: [1] };
    expect(noteCovers(schedule, '2030-01-07')).toBe(true);
    expect(noteCovers(schedule, '2026-01-06')).toBe(false);
    expect(noteCovers(schedule, '2026-01-04')).toBe(false);
    const week = note({ startDate: '2026-01-05', endDate: '2026-01-11' });
    expect([noteCovers(week, '2026-01-05'), noteCovers(week, '2026-01-11'), noteCovers(week, '2026-01-12')]).toEqual([true, true, false]);
    expect(isClosure({ kind: 'closure', effect: 'unknown' })).toBe(true);
    expect(isClosure({ kind: 'private_event', effect: 'closed' })).toBe(true);
    expect(isClosure({ kind: 'other', effect: 'fewer_guests' })).toBe(false);
  });
});

describe('the audit summary of an answer', () => {
  it('words each answer, for days with no sales and for a day with almost no guests', () => {
    const summary = (questionId: string, answer: string) => summaryOf('agent.question_answered', { locationId: 'l1', questionId, answer });
    const gapId = 'gap_2026-02-10_2026-02-11';
    expect([
      summary(gapId, 'closed'), summary(gapId, 'open'), summary(gapId, 'not_sure'), summary(`weekday_1_${FROM}_${TO}`, 'other'),
    ]).toEqual([
      'Answered TownwiseAI’s question about days with no sales: closed on those days',
      'Answered TownwiseAI’s question about days with no sales: the data is missing',
      'Answered TownwiseAI’s question about days with no sales: not sure',
      'Answered TownwiseAI’s question about days with no sales: answered in the chat',
    ]);
    const likelyId = 'likely_closed_2026-03-14';
    expect([summary(likelyId, 'closed'), summary(likelyId, 'open'), summary(likelyId, 'not_sure'), summary(likelyId, 'other')]).toEqual([
      'Answered TownwiseAI’s question about a day with almost no guests: closed that day',
      'Answered TownwiseAI’s question about a day with almost no guests: open, with few guests',
      'Answered TownwiseAI’s question about a day with almost no guests: not sure',
      'Answered TownwiseAI’s question about a day with almost no guests: answered in the chat',
    ]);
  });
});
