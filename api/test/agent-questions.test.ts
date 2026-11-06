// TownwiseAI's rule-based questions (src/agent/questions.ts, spec 10.12): weekday closures at 60%, gaps grouped into
// runs, days a note or an earlier answer explains left out, at most 5 in a fixed order, over the last 365 days of
// coverage. Synthetic days only.
import { describe, expect, it } from 'vitest';

import {
  closureNoteOf, MAX_QUESTIONS, parseQuestionId, questionId, questionsFor, questionWindow, type QuestionInput,
} from '../src/agent/questions.ts';
import { readNoteContent } from '../src/handlers/notes.ts';
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

/** A row for every day from `from` to `to` with a value, except the days `missing` leaves out. */
function input(from: string, to: string, missing: (day: string) => boolean, extra: Partial<QuestionInput> = {}): QuestionInput {
  const days: SalesDay[] = range(from, to).filter((day) => !missing(day)).map((date) => ({ date, guests: 10, netSalesCents: null }));
  return { coverage: { firstDate: from, lastDate: to }, days, notes: [], answered: [], ...extra };
}

function note(over: Partial<NoteContent>): NoteContent {
  return {
    kind: 'closure', startDate: '2026-01-01', endDate: '2026-01-01', weekdays: null, effect: 'closed', expectedGuests: null,
    detail: null, ...over,
  };
}

// 2026-01-05 is a Monday; ten weeks run to Sunday 2026-03-15.
const FROM = '2026-01-05';
const TO = '2026-03-15';
const mondays = range(FROM, TO).filter((day) => weekday(day) === 1);

describe('weekday closures', () => {
  it('asks about a weekday with no sales on at least 60% of its days in the window, and not below', () => {
    expect(mondays).toHaveLength(10);
    const six = new Set(mondays.slice(1, 7));
    expect(questionsFor(input(FROM, TO, (day) => six.has(day)))).toEqual([{
      id: `weekday_1_${FROM}_${TO}`, kind: 'weekday', weekday: 1, from: FROM, to: TO, noSalesCount: 6, weekdayCount: 10,
    }]);
    const five = new Set(mondays.slice(1, 6));
    // Below 60% the missing Mondays are ordinary gaps instead.
    expect(questionsFor(input(FROM, TO, (day) => five.has(day))).map((q) => q.kind)).toEqual(['gap', 'gap', 'gap', 'gap', 'gap']);
  });

  it('needs at least 4 of the weekday in the window', () => {
    const short = input('2026-01-04', '2026-01-25', (day) => weekday(day) === 1);
    expect(range('2026-01-04', '2026-01-25').filter((day) => weekday(day) === 1)).toHaveLength(3);
    expect(questionsFor(short).map((q) => q.kind)).toEqual(['gap', 'gap', 'gap']);
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
});

describe('gaps', () => {
  it('groups consecutive days with no sales into one question each', () => {
    const missing = new Set(['2026-02-10', '2026-02-11', '2026-02-12', '2026-03-01']);
    expect(questionsFor(input(FROM, TO, (day) => missing.has(day)))).toEqual([
      { id: 'gap_2026-03-01_2026-03-01', kind: 'gap', from: '2026-03-01', to: '2026-03-01', dayCount: 1 },
      { id: 'gap_2026-02-10_2026-02-12', kind: 'gap', from: '2026-02-10', to: '2026-02-12', dayCount: 3 },
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
    expect(questionsFor(input(FROM, TO, missing, { answered }))).toEqual([
      { id: 'gap_2026-02-15_2026-02-17', kind: 'gap', from: '2026-02-15', to: '2026-02-17', dayCount: 3 },
    ]);
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
    // Two more weeks of data: 2 of 12 Mondays are unexplained, under 60%, and a closed Monday starts no gap.
    expect(questionsFor(input(FROM, '2026-03-29', closed, { answered }))).toEqual([]);
  });
});

describe('the cap and the order', () => {
  it('at most 5: weekday questions first, then gaps newest first', () => {
    const missing = (day: string) => weekday(day) === 3 || weekday(day) === 5
      || ['2026-01-13', '2026-01-20', '2026-01-27', '2026-02-03', '2026-02-10'].includes(day);
    const questions = questionsFor(input(FROM, TO, missing));
    expect(questions).toHaveLength(MAX_QUESTIONS);
    expect(questions.map((q) => q.id)).toEqual([
      `weekday_3_${FROM}_${TO}`, `weekday_5_${FROM}_${TO}`,
      'gap_2026-02-10_2026-02-10', 'gap_2026-02-03_2026-02-03', 'gap_2026-01-27_2026-01-27',
    ]);
  });

  it('asks nothing of a location with no sales, or with every day present', () => {
    expect(questionsFor({ coverage: { firstDate: null, lastDate: null }, days: [], notes: [], answered: [] })).toEqual([]);
    expect(questionWindow({ firstDate: null, lastDate: null })).toBeNull();
    expect(questionsFor(input(FROM, TO, () => false))).toEqual([]);
  });
});

describe('question ids and the notes a closed answer saves', () => {
  it('an id round-trips to what it asks, and anything else names no question', () => {
    for (const asked of [
      { kind: 'weekday', weekday: 1, from: FROM, to: TO }, { kind: 'gap', from: '2026-12-24', to: '2026-12-26' },
    ] as const) {
      expect(parseQuestionId(questionId(asked))).toEqual(asked);
    }
    for (const id of [
      'gap_2026-12-26_2026-12-24', 'gap_2026-02-30_2026-03-01', 'weekday_7_2026-01-05_2026-03-15', 'gap_2026-12-24',
      'weekday_1_2025-01-01_2026-01-01', 'other_2026-12-24_2026-12-26',
    ]) {
      expect(parseQuestionId(id)).toBeNull();
    }
  });

  it('a closed answer saves a closure note over the gap, or the weekday over the window, that passes the notes rules', () => {
    const gap = closureNoteOf({ kind: 'gap', from: '2026-12-24', to: '2026-12-26' });
    expect(gap).toEqual(note({ startDate: '2026-12-24', endDate: '2026-12-26' }));
    const weekly = closureNoteOf({ kind: 'weekday', weekday: 1, from: plus(TO, -364), to: TO });
    expect(weekly).toEqual(note({ startDate: plus(TO, -364), endDate: TO, weekdays: [1] }));
    for (const content of [gap, weekly]) expect(readNoteContent(content, TO)).toEqual(content);
  });
});
