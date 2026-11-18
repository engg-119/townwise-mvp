import { buildWeek, entryLines, type WeekDay } from '../../../src/portal/calendar/grid';
import { dayCell, monthBounds, tooltipLines } from '../../../src/portal/calendar/model';
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
