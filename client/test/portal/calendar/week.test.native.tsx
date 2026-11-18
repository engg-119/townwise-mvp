import { Dimensions } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';

import { CalendarWeek } from '../../../src/portal/calendar/CalendarWeek';
import { buildWeek, gridRange, weekLabel } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { note, townEvent } from '../analytics/fakes';
import { forecastDay, forecastOf } from './fakes';

// The Calendar's week view on native (P28, spec 16.3): an agenda at every width, 7 Pressable rows labeled as their
// month cells with their selected state, each a head line over the day's full cards; pressing a row selects its day.
// Today is Wed, Nov 11, 2026, so Saturday Nov 21 is in the block of Nov 18 to 24, its fourth row. Made-up titles only.

afterEach(() => {
  jest.restoreAllMocks();
});

const TODAY = '2026-11-11';
const SATURDAY = '2026-11-21';
const BOUNDS = monthBounds(TODAY);

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, covered: gridRange('2026-11', BOUNDS), forecast: forecastOf([forecastDay({ date: SATURDAY })]) as ForecastWindow, salesDays: [],
    events: [townEvent({ start: SATURDAY, title: 'Dartmouth home football' })],
    notes: [note({ startDate: SATURDAY, expectedGuests: 70, startTime: '18:00', endTime: '21:00' })],
    imported: [{ calendarId: 'c1', uid: 'i1', title: 'Wine delivery', startDate: SATURDAY, endDate: SATURDAY, startTime: '09:00', endTime: '10:00' }],
    filters: ALL_FILTERS,
    ...fields,
  };
}

async function renderWeek(width: number, onSelect: jest.Mock = jest.fn(), reads: CalendarInput = input()): Promise<jest.Mock> {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 2, fontScale: 1 });
  await render(
    <CalendarWeek
      days={buildWeek(SATURDAY, TODAY, reads, BOUNDS)}
      selected={SATURDAY}
      weekStart="2026-11-18"
      bounds={BOUNDS}
      onSelect={onSelect}
      busy={false}
      label={weekLabel('2026-11-18')}
      tooltip={() => null}
    />,
  );
  return onSelect;
}

test('7 Pressable rows labeled as their days, the selected one with its state, at every width', async () => {
  for (const width of [375, 1280]) {
    await renderWeek(width);
    const days = buildWeek(SATURDAY, TODAY, input(), BOUNDS);
    const rows = screen.getAllByRole('button');
    expect(rows.map((row) => row.props.accessibilityLabel as unknown)).toEqual(days.map((day) => day.label));
    for (const row of rows) {
      expect(row.props.accessibilityState).toMatchObject({ selected: row.props.accessibilityLabel === days[3]?.label });
    }
    expect(screen.getByLabelText('Nov 18 to 24, 2026')).toBeTruthy();
  }
});

test('pressing a row selects its day', async () => {
  const onSelect = await renderWeek(375);
  const days = buildWeek(SATURDAY, TODAY, input(), BOUNDS);
  await fireEvent.press(screen.getByLabelText(days[1]?.label ?? ''));
  expect(onSelect).toHaveBeenCalledWith('2026-11-19');
});

test('a row is one accessible element, so its hint reads its cards, a timed one’s hours included; a day with none has no hint', async () => {
  await renderWeek(375);
  const rows = screen.getAllByRole('button');
  const hint = rows[3]?.props.accessibilityHint as unknown;
  expect(typeof hint).toBe('string');
  expect(hint).toContain('Dartmouth home football. Town event.');
  expect(hint).toContain('6 pm to 9 pm, Private event, 70. Your note.');
  expect(rows[0]?.props.accessibilityHint).toBeUndefined();
});

test('each row is its head line over the day’s full cards, in the entries’ order (D49)', async () => {
  await renderWeek(375);
  const saturday = screen.getAllByRole('button')[3];
  if (saturday === undefined) throw new Error('no Saturday');
  expect(within(saturday).getByText('Sat 21')).toBeTruthy();
  expect(within(saturday).getByText('~212')).toBeTruthy();
  expect(within(saturday).getByText('forecast, 180 to 240')).toBeTruthy();
  const texts = within(saturday).getAllByText(/./).map((each) => each.props.children as unknown);
  const order = ['6 pm to 9 pm', 'Private event, 70', 'Dartmouth home football', '9 am to 10 am', 'Wine delivery'].map((text) => texts.indexOf(text));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(within(saturday).getAllByText('Your note')).toHaveLength(1);
  expect(within(saturday).getByText('Your calendar')).toBeTruthy();
});

test('an outlook day’s row (D52): Outlook over its figure and its range, and its label says outlook', async () => {
  const forecast = forecastOf([forecastDay({ date: SATURDAY, low: 150, mid: 212, high: 290, outlook: true })]) as ForecastWindow;
  await renderWeek(375, jest.fn(), input({ forecast }));
  const saturday = screen.getAllByRole('button')[3];
  if (saturday === undefined) throw new Error('no Saturday');
  expect(within(saturday).getByText('Outlook')).toBeTruthy();
  expect(within(saturday).getByText('~212')).toBeTruthy();
  expect(within(saturday).getByText('forecast, 150 to 290')).toBeTruthy();
  expect(saturday.props.accessibilityLabel).toContain('Outlook: 212 guests, forecast, likely 150 to 290.');
});

test('a term card shows its whole title, wrapping: no text in the row is cut to a number of lines', async () => {
  const finals = townEvent({ id: 'hanover-nh:2026-11-19:term', start: '2026-11-19', end: '2026-11-24', title: 'Fall term finals', kind: 'term' });
  await renderWeek(375, jest.fn(), input({ events: [finals] }));
  const saturday = screen.getAllByRole('button')[3];
  if (saturday === undefined) throw new Error('no Saturday');
  const card = within(saturday).getByText('Fall term finals Term, Nov 19 to 24');
  expect(card.props.numberOfLines).toBeUndefined();
  // Every card's text, the head's too: nothing in the agenda row is cut.
  for (const text of within(saturday).getAllByText(/./)) expect(text.props.numberOfLines).toBeUndefined();
});
