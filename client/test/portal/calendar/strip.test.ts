import { monthBounds } from '../../../src/portal/calendar/model';
import {
  followSelection, nearestDay, snapOffsets, stepView, stripDates, stripFor, stripLimits, stripStep, STRIP_GROW_DAYS, viewDates,
} from '../../../src/portal/calendar/strip';
import { addDays, daysBetween } from '../../../src/portal/locations/dates';

// The week view's scroll (P28, D64), pure: a day's step, the snap stop a scroll settles on, the selected day that
// follows the days in view, the days rendered as the person scrolls, and Previous and Next week. Today is Wed, Nov 11,
// 2026, so the 7-day blocks counted from today start on Wednesdays.

const TODAY = '2026-11-11';
const BOUNDS = monthBounds(TODAY);

describe('snapping', () => {
  test('a day’s step is a seventh of the view plus a seventh of the 3px gap, so 7 days and 6 gaps fill it', () => {
    expect(stripStep(1003)).toBeCloseTo(143.714, 3);
    expect(7 * stripStep(1003) - 3).toBeCloseTo(1003, 9);
    expect(stripStep(0)).toBe(0);
  });

  test('a scroll settles on the day whose left edge is nearest, halfway rounding on', () => {
    expect(nearestDay(0, 100, 35)).toBe(0);
    expect(nearestDay(49, 100, 35)).toBe(0);
    expect(nearestDay(50, 100, 35)).toBe(1);
    expect(nearestDay(351, 100, 35)).toBe(4);
    expect(nearestDay(-40, 100, 35)).toBe(0);
  });

  test('the last stop keeps 7 days in view, and a strip of 7 or fewer has only the first', () => {
    expect(nearestDay(99_999, 100, 35)).toBe(28);
    expect(nearestDay(250, 100, 7)).toBe(0);
    expect(nearestDay(250, 100, 3)).toBe(0);
  });

  test('an unmeasured view (a step of 0) stays on the first day', () => {
    expect(nearestDay(120, 0, 35)).toBe(0);
  });

  test('the snap stops are each day’s left edge up to the last full view', () => {
    expect(snapOffsets(100, 10)).toEqual([0, 100, 200, 300]);
    expect(snapOffsets(100, 7)).toEqual([0]);
  });
});

describe('the selected day follows the view', () => {
  test('a day in view stays selected', () => {
    expect(followSelection('2026-11-20', '2026-11-18')).toBe('2026-11-20');
    expect(followSelection('2026-11-18', '2026-11-18')).toBe('2026-11-18');
    expect(followSelection('2026-11-24', '2026-11-18')).toBe('2026-11-24');
  });

  test('a day the view moved past becomes its first day; one it moved back from, its last', () => {
    expect(followSelection('2026-11-15', '2026-11-18')).toBe('2026-11-18');
    expect(followSelection('2026-12-02', '2026-11-18')).toBe('2026-11-24');
  });

  test('the 7 days in view', () => {
    expect(viewDates('2026-11-29')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05']);
  });
});

describe('the days rendered', () => {
  test('the strip’s limits are the first and last 7-day blocks of the 25 months', () => {
    // Nov 1, 2025 is in the block from Wed, Oct 29, 2025; Nov 30, 2027 ends the block from Wed, Nov 24, 2027.
    expect(stripLimits(BOUNDS, TODAY)).toEqual({ from: '2025-10-29', to: '2027-11-30' });
  });

  test('at first, 5 weeks: two before the view, the view, two after', () => {
    const strip = stripFor(null, TODAY, BOUNDS, TODAY);
    expect(strip).toEqual({ from: '2026-10-28', to: '2026-12-01' });
    expect(stripDates(strip)).toHaveLength(35);
  });

  test('a view inside the strip, a week or more from its ends, keeps it as it is', () => {
    const strip = { from: '2026-10-28', to: '2026-12-01' };
    expect(stripFor(strip, '2026-11-04', BOUNDS, TODAY)).toBe(strip);
    expect(stripFor(strip, '2026-11-18', BOUNDS, TODAY)).toBe(strip);
  });

  test('a view stopped within a week of an end grows that end by 3 weeks', () => {
    const strip = { from: '2026-10-28', to: '2026-12-01' };
    expect(STRIP_GROW_DAYS).toBe(21);
    // Nov 20 to 26 ends 5 days before Dec 1.
    expect(stripFor(strip, '2026-11-20', BOUNDS, TODAY)).toEqual({ from: '2026-10-28', to: '2026-12-22' });
    // Oct 31 starts 3 days after Oct 28.
    expect(stripFor(strip, '2026-10-31', BOUNDS, TODAY)).toEqual({ from: '2026-10-07', to: '2026-12-01' });
  });

  test('a view that leaves the strip near it extends the strip to it; one far away starts a fresh 5 weeks', () => {
    const strip = { from: '2026-10-28', to: '2026-12-01' };
    // Next week from the strip's last full view: the strip runs on to cover it and 2 weeks more.
    expect(stripFor(strip, '2026-11-30', BOUNDS, TODAY)).toEqual({ from: '2026-10-28', to: '2026-12-20' });
    // A month on (PageDown, or a link): a fresh strip, so no 5-week scroll runs to it.
    expect(stripFor(strip, '2027-01-06', BOUNDS, TODAY)).toEqual({ from: '2026-12-23', to: '2027-01-26' });
  });

  test('the strip never runs past the first or last block of the 25 months', () => {
    expect(stripFor(null, '2025-10-29', BOUNDS, TODAY)).toEqual({ from: '2025-10-29', to: '2025-11-18' });
    expect(stripFor(null, '2027-11-24', BOUNDS, TODAY)).toEqual({ from: '2027-11-10', to: '2027-11-30' });
    const start = { from: '2025-10-29', to: '2025-12-02' };
    expect(stripFor(start, '2025-10-30', BOUNDS, TODAY)).toBe(start);
  });

  test('every strip holds its view whole', () => {
    for (let start = '2025-10-29'; start <= '2027-11-24'; start = addDays(start, 11)) {
      const strip = stripFor(null, start, BOUNDS, TODAY);
      expect(strip.from <= start && addDays(start, 6) <= strip.to).toBe(true);
      expect(daysBetween(strip.from, strip.to)).toBeLessThan(35);
    }
  });
});

describe('Previous week and Next week', () => {
  test('move the view 7 days, from wherever a scroll left it', () => {
    expect(stepView(TODAY, 1, BOUNDS, TODAY)).toBe('2026-11-18');
    expect(stepView('2026-11-14', -1, BOUNDS, TODAY)).toBe('2026-11-07');
  });

  test('stop at the first and last blocks, clamped, and are null there', () => {
    expect(stepView('2025-11-01', -1, BOUNDS, TODAY)).toBe('2025-10-29');
    expect(stepView('2025-10-29', -1, BOUNDS, TODAY)).toBeNull();
    expect(stepView('2027-11-20', 1, BOUNDS, TODAY)).toBe('2027-11-24');
    expect(stepView('2027-11-24', 1, BOUNDS, TODAY)).toBeNull();
  });
});
