import { buildWeek, entryLines, type WeekDay } from '../../../src/portal/calendar/grid';
import { researchedEventSchema } from '../../../src/portal/analytics/api';
import { dayCell, dayView, monthBounds, tooltipLines } from '../../../src/portal/calendar/model';
import { foundEvent } from './fakes';
import { PARITY_DAY, PARITY_ORDER, PARITY_TODAY, parityInput } from './parity-fixture';

// One fixture day through every compact surface (D49, day-entries "One fixture day on every surface"): the month
// cell's lines, the week view's cards and the tooltip give the same order and the same dedupe, cut only by each
// surface's own limit. Home's This week joins in test/portal/home/week.test.ts.

test('the week cards show every compact entry in the one order', () => {
  const input = parityInput();
  const day = buildWeek(PARITY_DAY, PARITY_TODAY, input, monthBounds(PARITY_TODAY)).find((slot): slot is WeekDay => slot.date === PARITY_DAY && 'cards' in slot);
  expect(day?.cards.map((card) => card.title)).toEqual(PARITY_ORDER);
});

test('the month cell shows the same order, cut to two lines and “+N more”', () => {
  const cell = dayCell(PARITY_DAY, parityInput());
  expect([...cell.chips.slice(0, 3)]).toEqual(PARITY_ORDER.slice(0, 3));
  expect(entryLines(cell)).toEqual({ lines: PARITY_ORDER.slice(0, 2), more: `+${String(PARITY_ORDER.length - 2)} more` });
});

test('the tooltip shows the same order after its status line, cut to two and “+N more”', () => {
  expect(tooltipLines(PARITY_DAY, parityInput())?.lines).toEqual([
    '212 guests, forecast (likely 180 to 240)', ...PARITY_ORDER.slice(0, 2), `+${String(PARITY_ORDER.length - 2)} more`,
  ]);
});

test('a found event (D66) comes last on every compact surface, after the imported events, and in the day panel’s own list', () => {
  const found = researchedEventSchema.parse(foundEvent({ start: PARITY_DAY, end: PARITY_DAY }));
  const input = parityInput({ found: [found] });
  const day = buildWeek(PARITY_DAY, PARITY_TODAY, input, monthBounds(PARITY_TODAY)).find((slot): slot is WeekDay => slot.date === PARITY_DAY && 'cards' in slot);
  expect(day?.cards.map((card) => card.title)).toEqual([...PARITY_ORDER, 'Trivia night']);
  expect(day?.cards.at(-1)).toMatchObject({ kind: 'researched', sub: 'Found by research', hours: 'From 7 pm' });
  expect(dayCell(PARITY_DAY, input).label.endsWith('Private party. Found by research: Trivia night.')).toBe(true);
  expect(dayView(PARITY_DAY, input).researched.map((event) => event.title)).toEqual(['Trivia night']);
  expect(dayView(PARITY_DAY, { ...input, filters: { ...input.filters, researched: false } }).researched).toEqual([]);
});
