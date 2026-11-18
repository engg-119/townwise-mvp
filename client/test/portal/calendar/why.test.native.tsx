import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { CalendarDay } from '../../../src/portal/calendar/CalendarDay';
import { ALL_FILTERS, dayView, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastDay, ForecastReason, ReasonEffect } from '../../../src/portal/estimates/api';
import { theme } from '../../../src/theme';
import { forecastDay, forecastOf } from './fakes';

// Why's colored marks on native (forecast-why, "Marks are colored by the size of the effect"): the same marks in the
// same effect tokens as on web (theme.color is the dark palette here), = in text2, a note's ▲ before its words, none at
// 0, and each mark in a part screen readers skip. Today is Wed, Nov 11, 2026; the day is Tue, Nov 17, on a model middle
// figure of 200. Synthetic figures and made-up labels only.

/** A host element as the renderer gives it: its type, props and children. */
interface Host { type: unknown; props: Record<string, unknown>; children: readonly (Host | string)[] }

const TODAY = '2026-11-11';
const DAY = '2026-11-17';
const MARKS = /^[▲▼=]$/;

const run = (kind: string, label: string, direction: ReasonEffect['direction'], pct: number, basis: ReasonEffect['basis'] = 'history'): ForecastReason => ({
  kind, label, effectPct: null, effect: { direction, pct, basis, days: basis === 'model' ? null : 20 }, sources: [], note: null,
});
const yours = (label: string, guests: number | null, outcome: string): ForecastReason => ({
  kind: 'note', label, effectPct: null, sources: [], note: { id: label, guests, outcome },
});

async function renderDay(reasons: ForecastReason[], fields: Partial<ForecastDay> = {}): Promise<void> {
  const day = forecastDay({ date: DAY, model: { status: 'open', low: 170, mid: 200, high: 230 }, reasons, ...fields });
  const input: CalendarInput = {
    today: TODAY, covered: { from: '2026-10-26', to: '2026-12-06' }, forecast: forecastOf([day]) as CalendarInput['forecast'], salesDays: [],
    events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  await render(
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
    />,
  );
}

/** Every mark in Why's order, hidden ones included, with its color. */
function marks(): [unknown, string | undefined][] {
  return screen.getAllByText(MARKS, { includeHiddenElements: true })
    .map((mark) => [mark.props.children, (StyleSheet.flatten(mark.props.style as never) as { color?: string }).color]);
}

/** The panel's words in order, a mark's included. */
function words(node: Host): string[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : words(child)));
}

function descendants(node: Host): Host[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [] : [child, ...descendants(child)]));
}

test('each mark has its grade’s effect token, and = has text2', async () => {
  await renderDay([
    run('weekday', 'Tuesday', 'more', 10),
    run('event', 'Turkey trot', 'more', 35),
    run('term', 'Fall term', 'more', 40, 'model'),
    run('holiday', 'Thanksgiving Day', 'fewer', 15),
    run('booking', 'Private event booked', 'fewer', 20, 'model'),
    run('level', 'Your recent level', 'fewer', 70, 'model'),
    run('weekend', 'Weekend', 'same', 5),
  ]);
  const c = theme.color;
  expect(marks()).toEqual([
    ['▲', c.effectUp3], ['▲', c.effectUp2], ['▲', c.effectUp1], ['=', c.text2], ['▼', c.effectDown1], ['▼', c.effectDown2], ['▼', c.effectDown3],
  ]);
  // Native keeps the dark palette's hex values.
  expect(c.effectUp3).toBe('#5fd98f');
});

test('a note of 70 guests on a middle of 200 shows ▲ in effectUp2 before “Adds 70 guests”; one of 10 guests shows none', async () => {
  await renderDay([yours('Your private event, 10 guests', 10, 'added'), yours('Your private event, 70 guests', 70, 'added')]);
  const shown = words(screen.getByLabelText('Selected day'));
  const at = shown.indexOf('Your private event, 70 guests');
  expect(shown.slice(at, at + 5)).toEqual(['Your private event, 70 guests', '▲', 'Adds 70 guests', 'Your private event, 10 guests', 'Adds 10 guests']);
  expect(marks()).toEqual([['▲', theme.color.effectUp2]]);
});

test('each mark is in a part screen readers skip, and the words that say the same are not', async () => {
  await renderDay([run('weekday', 'Tuesday', 'more', 35), yours('Your closure', null, 'closed')]);
  // Hidden from the accessibility tree: found only with hidden elements included.
  expect(screen.queryAllByText(MARKS)).toHaveLength(0);
  expect(screen.getAllByText(MARKS, { includeHiddenElements: true })).toHaveLength(2);
  const hidden = descendants(screen.getByLabelText('Selected day')).filter((node) => node.props.accessibilityElementsHidden === true);
  expect(hidden.map((part) => [words(part), part.props.importantForAccessibility, part.props['aria-hidden']])).toEqual([
    [['▲'], 'no-hide-descendants', true], [['▼'], 'no-hide-descendants', true],
  ]);
  expect(screen.getByText('Usually about 35% more guests than your average day')).toBeTruthy();
  expect(screen.getByText('Closes the day')).toBeTruthy();
});
