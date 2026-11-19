import { cleanup, render, screen, within } from '@testing-library/react';

import { CalendarDay } from '../../../src/portal/calendar/CalendarDay';
import { ALL_FILTERS, dayView, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastDay, ForecastReason, ReasonEffect } from '../../../src/portal/estimates/api';
import type { ColorToken } from '../../../src/theme';
import { theme } from '../../../src/theme';
import { forecastDay, forecastOf } from './fakes';

// Why's colored marks on web (forecast-why, "Marks are colored by the size of the effect"): each reason's ▲ or ▼ in
// its grade's effect token, = in text2, notes and rules marked by their size, none at 0, and every mark hidden from
// screen readers, which hear the words. Today is Wed, Nov 11, 2026; the day is Tue, Nov 17, on a model middle figure
// of 200. Synthetic figures and made-up labels only.

afterEach(() => {
  cleanup();
});

const TODAY = '2026-11-11';
const DAY = '2026-11-17';

const run = (kind: string, label: string, direction: ReasonEffect['direction'], pct: number, basis: ReasonEffect['basis'] = 'history'): ForecastReason => ({
  kind, label, effectPct: null, effect: { direction, pct, basis, days: basis === 'model' ? null : 20 }, sources: [], note: null,
});
const yours = (label: string, guests: number | null, outcome: string): ForecastReason => ({
  kind: 'note', label, effectPct: null, sources: [], note: { id: label, guests, outcome },
});

function renderDay(reasons: ForecastReason[], fields: Partial<ForecastDay> = {}): HTMLElement[] {
  const day = forecastDay({ date: DAY, model: { status: 'open', low: 170, mid: 200, high: 230 }, reasons, ...fields });
  const input: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' }, forecast: forecastOf([day]) as CalendarInput['forecast'], salesDays: [],
    events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  render(
    <CalendarDay
      view={dayView(DAY, input)}
      locationName="Main Street Bar"
      rulesHref="/locations/l1/rules" locationId="l1"
      notice={null}
      readOnlyId={null}
      readOnlyText=""
      onAdd={jest.fn()}
      onEdit={jest.fn()}
      onDelete={jest.fn()}
      onMakeNote={jest.fn()}
      onEditFound={jest.fn()}
      onFoundAction={jest.fn()}
      onAskFound={jest.fn()}
    />,
  );
  return within(screen.getByRole('region', { name: 'Selected day' })).getAllByRole('listitem');
}

/** A Why row's mark: the text inside its part hidden from screen readers; null when the row has none. */
function markOf(row: HTMLElement): HTMLElement | null {
  const hidden = row.querySelectorAll<HTMLElement>('[aria-hidden="true"]');
  expect(hidden.length).toBeLessThanOrEqual(1);
  const part = hidden[0];
  if (part === undefined) return null;
  const text = [...part.querySelectorAll<HTMLElement>('*')].find((each) => each.children.length === 0) ?? part;
  return text;
}

/** Each row as [its text, its mark, the mark's color token]. */
function rowsOf(rows: HTMLElement[]): [string, string | null, ColorToken | null][] {
  const tokens = Object.keys(theme.color) as ColorToken[];
  return rows.map((row) => {
    const mark = markOf(row);
    const color = mark === null ? null : window.getComputedStyle(mark).color;
    return [row.textContent, mark?.textContent ?? null, tokens.find((token) => theme.color[token] === color) ?? null];
  });
}

test('each mark is colored by its size’s grade: greener the bigger the rise, redder the bigger the fall', () => {
  const rows = renderDay([
    run('weekday', 'Tuesday', 'more', 10),
    run('event', 'Turkey trot', 'more', 35),
    run('term', 'Fall term', 'more', 40, 'model'),
    run('holiday', 'Thanksgiving Day', 'fewer', 15),
    run('booking', 'Private event booked', 'fewer', 20, 'model'),
    run('level', 'Your recent level', 'fewer', 70, 'model'),
  ]);
  expect(rowsOf(rows).map(([, mark, token]) => [mark, token])).toEqual([
    ['▲', 'effectUp3'], ['▲', 'effectUp2'], ['▲', 'effectUp1'], ['▼', 'effectDown1'], ['▼', 'effectDown2'], ['▼', 'effectDown3'],
  ]);
  // The words keep their own color: only the mark carries the ramp.
  const words = within(rows[0] ?? document.body).getByText('Townwise’s model: about 40% more guests');
  expect(window.getComputedStyle(words).color).toBe(theme.color.text2);
});

test('= for about the same is text2, the gray every grade is held against', () => {
  expect(rowsOf(renderDay([run('weekday', 'Tuesday', 'same', 5)]))).toEqual([['Tuesday=Usually about as many guests as your average day', '=', 'text2']]);
});

test('a note that adds 70 guests on a middle of 200 shows ▲ in effectUp2 before “Adds 70 guests”; one of 10 guests shows none', () => {
  const rows = renderDay([yours('Your private event, 10 guests', 10, 'added'), yours('Your private event, 70 guests', 70, 'added')]);
  expect(rowsOf(rows)).toEqual([
    ['Your private event, 70 guests▲Adds 70 guests', '▲', 'effectUp2'],
    ['Your private event, 10 guestsAdds 10 guests', null, null],
  ]);
});

test('a buyout of 70 against the model’s 200 shows ▼ in effectDown3, and its words say fewer guests', () => {
  const rows = renderDay([yours('Your private buyout, 70 guests', 70, 'booked')], { status: 'booked', low: null, mid: null, high: null, noteGuests: 70 });
  expect(rowsOf(rows)).toEqual([
    ['Your private buyout, 70 guests▼Books the day: about 65% fewer guests than Townwise’s model', '▼', 'effectDown3'],
  ]);
});

test('every mark is hidden from screen readers, and the words that say the same are not', () => {
  const rows = renderDay([
    run('weekday', 'Tuesday', 'more', 35), run('term', 'Fall term', 'same', 5), yours('Your closure', null, 'closed'),
  ]);
  expect(rows.map((row) => markOf(row)?.textContent)).toEqual(['▲', '=', '▼']);
  for (const mark of ['▲', '=', '▼']) {
    for (const each of screen.getAllByText(mark)) expect(each.closest('[aria-hidden="true"]')).not.toBeNull();
  }
  for (const words of ['Usually about 35% more guests than your average day', 'Closes the day']) {
    expect(screen.getByText(words).closest('[aria-hidden="true"]')).toBeNull();
  }
});
