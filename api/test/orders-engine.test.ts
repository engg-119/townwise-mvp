import { describe, expect, it } from 'vitest';

import {
  computeOrders,
  confidenceFor,
  draftBackupPar,
  guestIndex,
  indexSales,
  nextOrderFor,
  pastWindows,
  quantityFor,
  targetFor,
  weekdayMeans,
  whyLine,
  windowSigma,
  type EngineInput,
  type ItemSalesDay,
  type PastWindow,
  type SalesIndex,
  type SetupItem,
  type SetupSupplier,
  type WhyInput,
} from '../src/orders/engine.ts';
import { ITEM_SALES_DAYS } from '../src/orders/live.ts';

// Synthetic numbers only. 2026-11-10 is a Tuesday.
const TUESDAY = '2026-11-10';

function plusDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Every day from `from` through `to` covered, with the servings `sold` gives for it. */
function covered(from: string, to: string, sold: (date: string) => Record<string, number>): ItemSalesDay[] {
  const days: ItemSalesDay[] = [];
  for (let date = from; date <= to; date = plusDays(date, 1)) days.push({ date, items: sold(date) });
  return days;
}

const SAWTOOTH: SetupSupplier = {
  id: 'sup-a',
  name: 'Supplier A',
  deliveries: [
    { deliveryWeekday: 1, cutoffWeekday: 6, cutoffTime: '12:00' },
    { deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '14:00' },
    { deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '17:00' },
  ],
};

/** Thursday deliveries only, order by Wednesday 17:00. From a Tuesday the window is Wed through the next Wed, 8 days. */
const WEEKLY: SetupSupplier = { id: 'sup-w', name: 'Weekly', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '17:00' }] };

function item(overrides: Partial<SetupItem> = {}): SetupItem {
  return {
    id: 'i1',
    name: 'Lime juice',
    supplierId: 'sup-w',
    category: 'cocktail_ingredient',
    unit: 'cases',
    servingsPerUnit: 10,
    par: 0,
    dealSize: null,
    neverRunOut: false,
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    suppliers: [WEEKLY],
    items: [item()],
    itemSales: [],
    counts: new Map(),
    forecastGuests: new Map(),
    closedDays: new Set(),
    historyGuests: [],
    today: TUESDAY,
    nowMinutes: 9 * 60,
    ...overrides,
  };
}

function onlyLine(answer: ReturnType<typeof computeOrders>) {
  const line = answer[0]?.lines[0];
  if (line === undefined) throw new Error('no line');
  return line;
}

/** Four weeks covered, 10 servings a day: every weekday mean is 10, and 28 covered days. */
const FOUR_WEEKS = covered('2026-10-13', '2026-11-09', () => ({ i1: 10 }));

describe('next order', () => {
  it('follows a Sawtooth-style schedule: on a Tuesday, order Wednesday for Thursday, covering through Monday', () => {
    expect(nextOrderFor(SAWTOOTH, TUESDAY, 10 * 60)).toEqual({
      cutoff: '2026-11-11',
      cutoffTime: '17:00',
      delivery: '2026-11-12',
      coversThrough: '2026-11-16',
      windowStart: '2026-11-11',
      windowEnd: '2026-11-15',
    });
    // On Saturday morning the Monday delivery is next, and it covers through Tuesday's.
    expect(nextOrderFor(SAWTOOTH, '2026-11-14', 9 * 60)).toMatchObject({
      cutoff: '2026-11-14', delivery: '2026-11-16', windowEnd: '2026-11-16', coversThrough: '2026-11-17',
    });
  });

  it('moves to next week once the cutoff passed earlier today', () => {
    const wednesday = '2026-11-11';
    const supplier: SetupSupplier = { id: 's', name: 'S', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '14:00' }] };
    expect(nextOrderFor(supplier, wednesday, 13 * 60 + 59)?.cutoff).toBe(wednesday);
    expect(nextOrderFor(supplier, wednesday, 14 * 60)?.cutoff).toBe('2026-11-18');
    expect(nextOrderFor(supplier, wednesday, 15 * 60)).toMatchObject({ cutoff: '2026-11-18', delivery: '2026-11-19' });
  });

  it('delivers the same day when the cutoff and the delivery share a weekday', () => {
    const monday = '2026-11-16';
    const supplier: SetupSupplier = { id: 's', name: 'S', deliveries: [{ deliveryWeekday: 1, cutoffWeekday: 1, cutoffTime: '10:00' }] };
    expect(nextOrderFor(supplier, monday, 9 * 60)).toEqual({
      cutoff: monday,
      cutoffTime: '10:00',
      delivery: monday,
      coversThrough: '2026-11-23',
      windowStart: monday,
      windowEnd: '2026-11-22',
    });
    expect(nextOrderFor(supplier, monday, 10 * 60 + 30)).toMatchObject({ cutoff: '2026-11-23', delivery: '2026-11-23' });
  });

  it('has no order for a supplier with no deliveries', () => {
    expect(nextOrderFor({ id: 's', name: 'S', deliveries: [] }, TUESDAY, 0)).toBeNull();
  });
});

describe('the board', () => {
  it('orders suppliers by cutoff, each with only its own items, and skips a supplier with no items or deliveries', () => {
    const a: SetupSupplier = { id: 'a', name: 'A', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '14:00' }] };
    const b: SetupSupplier = { id: 'b', name: 'B', deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 1, cutoffTime: '12:00' }] };
    const idle: SetupSupplier = { id: 'c', name: 'C', deliveries: [{ deliveryWeekday: 5, cutoffWeekday: 4, cutoffTime: '12:00' }] };
    const noDays: SetupSupplier = { id: 'd', name: 'D', deliveries: [] };
    const plans = computeOrders(input({
      suppliers: [a, idle, noDays, b],
      items: [item({ id: 'x', name: 'From A', supplierId: 'a' }), item({ id: 'y', name: 'From B', supplierId: 'b' }), item({ id: 'z', supplierId: 'd' })],
      today: '2026-11-15',
    }));
    expect(plans.map((plan) => [plan.supplier, plan.cutoff, plan.cutoffTime])).toEqual([['B', '2026-11-16', '12:00'], ['A', '2026-11-18', '14:00']]);
    expect(plans.map((plan) => plan.lines.map((line) => line.itemId))).toEqual([['y'], ['x']]);
  });

  it('puts never-run-out lines first, then by name, and keeps a line at 0', () => {
    const plans = computeOrders(input({
      items: [item({ id: 'b', name: 'Bitters', par: 2 }), item({ id: 'z', name: 'Zest', neverRunOut: true }), item({ id: 'a', name: 'Agave', par: 1 })],
      counts: new Map([['a', { quantity: 3, date: TUESDAY }]]),
    }));
    const lines = plans[0]?.lines ?? [];
    expect(lines.map((line) => line.name)).toEqual(['Zest', 'Agave', 'Bitters']);
    expect(lines.find((line) => line.itemId === 'a')?.recommended).toBe(0);
  });

  it('orders the par at low confidence for an item never counted', () => {
    const line = onlyLine(computeOrders(input({ items: [item({ par: 4 })], itemSales: FOUR_WEEKS })));
    expect(line).toMatchObject({ recommended: 4, alternative: null, confidence: 'low', onHand: null, countAgeDays: null });
    expect(line.why).toContain('No count yet, so this is the par.');
    expect(line.why).not.toContain('chance');
  });

  it('follows the par at low confidence when the count is 9 days old', () => {
    const counts = new Map([['i1', { quantity: 2.5, date: '2026-11-01' }]]);
    const line = onlyLine(computeOrders(input({ items: [item({ par: 6 })], itemSales: FOUR_WEEKS, counts })));
    expect(line).toMatchObject({ recommended: 4, alternative: null, confidence: 'low', onHand: 2.5, countAgeDays: 9 });
    expect(line.why).toContain('The last count was 9 days ago, so this follows the par.');
  });

  it('is medium with a count 5 days old and asks for a count before sending', () => {
    const counts = new Map([['i1', { quantity: 1, date: '2026-11-05' }]]);
    const line = onlyLine(computeOrders(input({ itemSales: FOUR_WEEKS, counts })));
    expect(line.confidence).toBe('medium');
    expect(line.why).toContain('You counted 1 on Thu, Nov 5. Count it before you send the order.');
  });

  it('follows the par when a fresh count has no item sales behind it', () => {
    const counts = new Map([['i1', { quantity: 2, date: TUESDAY }]]);
    const line = onlyLine(computeOrders(input({ items: [item({ par: 6 })], counts })));
    expect(line).toMatchObject({ recommended: 4, mu: null, orderUpTo: null, confidence: 'low', coveredDays: 0 });
    expect(line.why).toContain('No item sales yet, so this follows the par.');
  });
});

describe('demand', () => {
  it('averages each weekday over the covered days of the 8 weeks before, an absent item counting zero', () => {
    const sales = indexSales([
      { date: '2026-11-09', items: { i1: 6 } }, // Monday
      { date: '2026-11-02', items: { other: 9 } }, // Monday, covered, i1 sold none
      { date: '2026-09-14', items: { i1: 100 } }, // Monday, 57 days before: outside the 8 weeks
      { date: '2026-09-15', items: { i1: 4 } }, // Tuesday, 56 days before: inside
      { date: TUESDAY, items: { i1: 50 } }, // today itself is not history
    ]);
    expect(weekdayMeans(sales, 'i1', TUESDAY)).toEqual([null, 3, 4, null, null, null, null]);
  });

  it('indexes forecast guests against the location’s own weekday guests in the same 8 weeks', () => {
    const history = [
      { date: '2026-10-14', guests: 100 },
      { date: '2026-10-21', guests: 140 },
      { date: '2026-10-28', guests: null },
      { date: '2026-11-04', guests: 120 },
      { date: '2026-09-09', guests: 1000 }, // more than 8 weeks back
      { date: '2026-11-05', guests: 500 }, // a Thursday
    ];
    const forecast = new Map([['2026-11-11', 180], ['2026-11-13', 90]]);
    expect(guestIndex('2026-11-11', forecast, history, TUESDAY)).toBeCloseTo(1.5, 9);
    expect(guestIndex('2026-11-12', forecast, history, TUESDAY)).toBeNull();
    expect(guestIndex('2026-11-13', forecast, history, TUESDAY)).toBeNull();
    expect(guestIndex('2026-11-11', forecast, [{ date: '2026-11-04', guests: 0 }], TUESDAY)).toBeNull();
  });

  it('sums the weekday means over the window with no forecast, and scales them by the guest index with one', () => {
    const counts = new Map([['i1', { quantity: 0, date: TUESDAY }]]);
    const plain = onlyLine(computeOrders(input({ itemSales: FOUR_WEEKS, counts })));
    expect(plain.mu).toBeCloseTo(8, 9); // 8 days x 10 servings / (10 servings per case x (1 - 0 loss))
    expect(plain.why).toContain('Expected use about 8 cases over these 8 days, from the last 8 weeks of sales.');
    expect(plain.coveredDays).toBe(28);

    const historyGuests = FOUR_WEEKS.map((day) => ({ date: day.date, guests: 100 }));
    const forecastGuests = new Map(covered('2026-11-11', '2026-11-18', () => ({})).map((day) => [day.date, 150] as const));
    const scaled = onlyLine(computeOrders(input({ itemSales: FOUR_WEEKS, counts, historyGuests, forecastGuests })));
    expect(scaled.mu).toBeCloseTo(12, 9);
    expect(scaled.why).toContain('from the last 8 weeks of sales, scaled to the guest forecast.');
  });

  it('converts servings to purchase units through the category’s loss rate', () => {
    const counts = new Map([['i1', { quantity: 0, date: TUESDAY }]]);
    const line = onlyLine(computeOrders(input({ items: [item({ category: 'draft', unit: 'kegs' })], itemSales: FOUR_WEEKS, counts })));
    expect(line.mu).toBeCloseTo(80 / (10 * 0.88), 9);
  });
});

describe('cushion', () => {
  it('lists the supplier’s windows closed in the last 26 weeks', () => {
    const windows = pastWindows(SAWTOOTH, TUESDAY);
    expect(windows).toHaveLength(78);
    expect(windows[0]).toEqual({ cutoff: '2026-05-11', delivery: '2026-05-12', end: '2026-05-13' });
    expect(windows.slice(-2)).toEqual([
      { cutoff: '2026-11-04', delivery: '2026-11-05', end: '2026-11-08' },
      { cutoff: '2026-11-07', delivery: '2026-11-09', end: '2026-11-09' },
    ]);
  });

  // Ten servings a day, with window A's days at 12 and window B's at 8. A and B are more than 8 weeks apart, so each
  // forecast is 5 x 10 = 50 and the errors are +10 and -10.
  const windowA = { cutoff: '2026-08-05', delivery: '2026-08-06', end: '2026-08-09' };
  const windowB = { cutoff: '2026-11-04', delivery: '2026-11-05', end: '2026-11-08' };
  const unseen = { cutoff: '2026-05-06', delivery: '2026-05-07', end: '2026-05-10' };
  const sold = (date: string): Record<string, number> => {
    if (date >= windowA.cutoff && date <= windowA.end) return { i1: 12 };
    if (date >= windowB.cutoff && date <= windowB.end) return { i1: 8 };
    return { i1: 10 };
  };

  it('is the sample standard deviation of past window errors, skipping windows with no covered days', () => {
    const sales = indexSales(covered('2026-06-01', '2026-11-09', sold));
    expect(windowSigma(sales, 'i1', [windowA, windowB, unseen])).toBeCloseTo(Math.sqrt(200), 9);
  });

  it('counts an item absent from a covered window day as zero', () => {
    const days = covered('2026-06-01', '2026-11-09', (date) => (date === '2026-11-08' ? {} : sold(date)));
    // B's actual is 4 x 8 + 0 = 32, so its error is -18.
    expect(windowSigma(indexSales(days), 'i1', [windowA, windowB])).toBeCloseTo(28 / Math.SQRT2, 9);
  });

  it('leaves an uncovered window day out of both the forecast and the actual', () => {
    const days = covered('2026-06-01', '2026-11-09', sold).filter((day) => day.date !== '2026-11-06');
    // B's forecast is 4 x 10 = 40 and its actual 4 x 8 = 32, so its error is -8.
    expect(windowSigma(indexSales(days), 'i1', [windowA, windowB])).toBeCloseTo(18 / Math.SQRT2, 9);
  });

  it('is null under 2 windows', () => {
    const sales = indexSales(covered('2026-06-01', '2026-11-09', sold));
    expect(windowSigma(sales, 'i1', [windowA, unseen])).toBeNull();
    expect(windowSigma(sales, 'i1', [])).toBeNull();
  });

  it('leaves S at mu and says there is no cushion yet when only one past window has closed', () => {
    // Covered from Wed Oct 21: the window ordered Oct 21 has no mean behind it, the one ordered Oct 28 does.
    const counts = new Map([['i1', { quantity: 2, date: TUESDAY }]]);
    const line = onlyLine(computeOrders(input({ itemSales: covered('2026-10-21', '2026-11-09', () => ({ i1: 10 })), counts })));
    expect(line).toMatchObject({ sigma: null, recommended: 6, confidence: 'medium', coveredDays: 20 });
    expect(line.orderUpTo).toBe(line.mu);
    // Medium from the short history, not the count, which is today's: so no request to count again.
    expect(line.why).toBe(
      'Thursday’s delivery lasts until next Thursday’s. Expected use about 8 cases over these 8 days, from the last 8 weeks of sales. '
      + 'You counted 2 on Tue, Nov 10. Item sales cover only 20 days of the last 8 weeks, so the history is short. '
      + 'Too little history for a safety cushion, so this covers the expected use.',
    );
  });

  it('computes sigma from overlapping weekly windows of a constructed history', () => {
    // Window ordered Oct 21 (Oct 21 to 28) sold 12 a day against a forecast of 10: error +16. Window ordered Oct 28
    // (Oct 28 to Nov 4) forecast 11 a day (two weeks, 10 and 12) and sold 12 then seven days of 10: 82 - 88 = -6.
    const days = covered('2026-10-14', '2026-11-09', (date) => ({ i1: date >= '2026-10-21' && date <= '2026-10-28' ? 12 : 10 }));
    const counts = new Map([['i1', { quantity: 0, date: TUESDAY }]]);
    const line = onlyLine(computeOrders(input({ itemSales: days, counts })));
    const sigma = Math.sqrt(242) / 10;
    // Wednesday means 11 (twice in the window), Tuesday 32 / 3, the other five weekdays 10.5.
    const mu = (11 * 2 + 10.5 * 5 + 32 / 3) / 10;
    expect(line.sigma).toBeCloseTo(sigma, 9);
    expect(line.mu).toBeCloseTo(mu, 9);
    expect(line.target).toBe(0.88);
    expect(line.orderUpTo).toBeCloseTo(mu + 1.175 * sigma, 9);
    expect(line.recommended).toBe(11);
    expect(line.why).toContain('Ordering 11 aims for an 88% chance of not running out.');
  });
});

describe('quantity', () => {
  it('matches the spec 5g vector: mu 14, sigma 3, 98%, 5 counted today, deals of 6 gives 18 with 12 as the alternative', () => {
    const { target, z } = targetFor({ neverRunOut: true, category: 'bottles_cans' });
    expect([target, z]).toEqual([0.98, 2.05]);
    expect(quantityFor({ par: 0, count: { quantity: 5, ageDays: 0 }, mu: 14, orderUpTo: 14 + z * 3, dealSize: 6 }))
      .toEqual({ recommended: 18, alternative: 12, byPar: false });
  });

  it('uses the category targets and z values', () => {
    expect(targetFor({ neverRunOut: false, category: 'bottles_cans' })).toEqual({ target: 0.95, z: 1.65 });
    expect(targetFor({ neverRunOut: false, category: 'draft' })).toEqual({ target: 0.95, z: 1.65 });
    expect(targetFor({ neverRunOut: false, category: 'liquor' })).toEqual({ target: 0.92, z: 1.405 });
    expect(targetFor({ neverRunOut: false, category: 'cocktail_ingredient' })).toEqual({ target: 0.88, z: 1.175 });
    expect(targetFor({ neverRunOut: true, category: 'cocktail_ingredient' })).toEqual({ target: 0.98, z: 2.05 });
  });

  it('swaps to the upper deal when the cheaper one leaves the count under par', () => {
    expect(quantityFor({ par: 7, count: { quantity: 0, ageDays: 0 }, mu: 2, orderUpTo: 2, dealSize: 6 }))
      .toEqual({ recommended: 12, alternative: 6, byPar: true });
  });

  it('has no alternative when both deal options are the same', () => {
    const fresh = { quantity: 0, ageDays: 0 };
    expect(quantityFor({ par: 0, count: fresh, mu: 12, orderUpTo: 12, dealSize: 6 })).toEqual({ recommended: 12, alternative: null, byPar: false });
    expect(quantityFor({ par: 0, count: fresh, mu: 2, orderUpTo: 2, dealSize: 6 })).toEqual({ recommended: 6, alternative: null, byPar: false });
  });

  it('rounds up to a whole unit without a deal size, and is never negative', () => {
    const count = { quantity: 2, ageDays: 1 };
    expect(quantityFor({ par: 0, count, mu: 10.2, orderUpTo: 10.2, dealSize: null })).toEqual({ recommended: 9, alternative: null, byPar: false });
    expect(quantityFor({ par: 0, count, mu: 10, orderUpTo: 10 + 1e-12, dealSize: null })).toEqual({ recommended: 8, alternative: null, byPar: false });
    expect(quantityFor({ par: 1, count: { quantity: 30, ageDays: 0 }, mu: 10, orderUpTo: 12, dealSize: 6 })).toEqual({ recommended: 0, alternative: null, byPar: false });
    expect(quantityFor({ par: 1, count: { quantity: 30, ageDays: 9 }, mu: 10, orderUpTo: 12, dealSize: null }).recommended).toBe(0);
  });

  it('orders the par with no count, and par minus the count with an old count or no sales', () => {
    expect(quantityFor({ par: 4, count: null, mu: 10, orderUpTo: 12, dealSize: 6 })).toEqual({ recommended: 4, alternative: null, byPar: false });
    expect(quantityFor({ par: 6, count: { quantity: 2.5, ageDays: 8 }, mu: 10, orderUpTo: 12, dealSize: 6 }))
      .toEqual({ recommended: 4, alternative: null, byPar: false });
    expect(quantityFor({ par: 6, count: { quantity: 2, ageDays: 0 }, mu: null, orderUpTo: null, dealSize: 6 }))
      .toEqual({ recommended: 4, alternative: null, byPar: false });
  });
});

describe('confidence', () => {
  it('is low without a count, an old count, item sales or a mean; medium for 3 to 7 days or under 28 covered days', () => {
    expect(confidenceFor(null, 40, 5)).toBe('low');
    expect(confidenceFor(8, 40, 5)).toBe('low');
    expect(confidenceFor(0, 0, 5)).toBe('low');
    expect(confidenceFor(0, 40, null)).toBe('low');
    expect(confidenceFor(7, 40, 5)).toBe('medium');
    expect(confidenceFor(3, 40, 5)).toBe('medium');
    expect(confidenceFor(2, 27, 5)).toBe('medium');
    expect(confidenceFor(2, 28, 5)).toBe('high');
  });
});

describe('why line', () => {
  const base: WhyInput = {
    delivery: '2026-11-12',
    coversThrough: '2026-11-16',
    windowDays: 5,
    unit: 'cases',
    mu: 14,
    scaled: false,
    count: { quantity: 5, date: TUESDAY },
    countAgeDays: 0,
    confidence: 'high',
    sigma: 3,
    recommended: 18,
    dealSize: 6,
    target: 0.98,
    closedDays: 0,
    sold: true,
    coveredDays: 56,
    par: 0,
    setupPar: 0,
    byPar: false,
  };

  it('names the target chance and the deals when sigma exists', () => {
    expect(whyLine(base)).toBe(
      'Thursday’s delivery lasts until Monday’s. Expected use about 14 cases over these 5 days, from the last 8 weeks of sales. '
      + 'You counted 5 on Tue, Nov 10. Ordering 18 (three deals of 6) aims for a 98% chance of not running out.',
    );
    expect(whyLine({ ...base, recommended: 6 })).toContain('Ordering 6 (one deal of 6) aims');
    expect(whyLine({ ...base, recommended: 10 })).toContain('Ordering 10 aims');
  });

  it('says there is no cushion yet without sigma', () => {
    expect(whyLine({ ...base, sigma: null })).toBe(
      'Thursday’s delivery lasts until Monday’s. Expected use about 14 cases over these 5 days, from the last 8 weeks of sales. '
      + 'You counted 5 on Tue, Nov 10. Too little history for a safety cushion, so this covers the expected use.',
    );
  });

  it('uses the singular for exactly one and one decimal otherwise', () => {
    expect(whyLine({ ...base, mu: 1, unit: 'kegs', windowDays: 1 })).toContain('Expected use about 1 keg over this day,');
    expect(whyLine({ ...base, mu: 2.44 })).toContain('about 2.4 cases');
  });

  it('never claims a chance for a quantity that follows the par', () => {
    const noCount = whyLine({ ...base, mu: null, coveredDays: 0, count: null, countAgeDays: null, confidence: 'low' });
    expect(noCount).toBe('Thursday’s delivery lasts until Monday’s. No item sales yet, so this follows the par. No count yet, so this is the par.');
    const old = whyLine({ ...base, count: { quantity: 5, date: '2026-11-01' }, countAgeDays: 9, confidence: 'low' });
    expect(old).toContain('The last count was 9 days ago, so this follows the par.');
    expect(old).not.toContain('chance');
  });
});

// Review fixes, each against what engine.py does or what the why line may honestly say.
describe('review fixes', () => {
  const fresh = (quantity: number) => new Map([['i1', { quantity, date: TUESDAY }]]);

  it('ports draft_backup_par: one more than the owner’s par when the window uses more than one unit (E1)', () => {
    expect(draftBackupPar(1.5, 2)).toBe(3);
    expect(draftBackupPar(1, 2)).toBe(2);
    expect(draftBackupPar(null, 2)).toBe(2);
    // An explicit par of 0 is the base, as engine.py treats any par it is given.
    expect(draftBackupPar(1.5, 0)).toBe(1);
    // Draft, par 2, mu 1.5 kegs, 0 counted today: engine.py's build_recommendation gives 3.
    expect(quantityFor({ par: draftBackupPar(1.5, 2), count: { quantity: 0, ageDays: 0 }, mu: 1.5, orderUpTo: 1.5, dealSize: null }))
      .toEqual({ recommended: 3, alternative: null, byPar: true });
    // 80 servings over the window at 50 a keg less 12% loss is about 1.8 kegs.
    const keg = item({ category: 'draft', unit: 'kegs', servingsPerUnit: 50, par: 2 });
    const line = onlyLine(computeOrders(input({ items: [keg], itemSales: FOUR_WEEKS, counts: fresh(0) })));
    expect(line).toMatchObject({ par: 3, recommended: 3 });
    expect(line.why).toContain('These days use more than one keg, so the par is one more than yours: 3.');
    expect(line.why).toContain('Ordering 3 brings your stock up to the par of 3.');
    // Not a draft item: the par stays the owner's.
    expect(onlyLine(computeOrders(input({ items: [{ ...keg, category: 'liquor' }], itemSales: FOUR_WEEKS, counts: fresh(0) }))).par).toBe(2);
  });

  it('gives an item no covered day sold no mean: the par, at low confidence, never a chance (E2)', () => {
    const neverSold = covered('2026-05-01', '2026-11-09', () => ({ other: 5 }));
    const line = onlyLine(computeOrders(input({ items: [item({ par: 4 })], itemSales: neverSold, counts: fresh(1) })));
    expect(line).toMatchObject({ mu: null, sigma: null, orderUpTo: null, confidence: 'low', recommended: 3, coveredDays: 56 });
    expect(line.why).toContain('The last 8 weeks of item sales show none of this item sold, so this follows the par.');
    expect(line.why).not.toContain('chance');
  });

  it('picks the earlier delivery when two rows share a cutoff day and time, in either order (E4)', () => {
    const thursday = { deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '14:00' };
    const monday = { deliveryWeekday: 1, cutoffWeekday: 3, cutoffTime: '14:00' };
    const expected = {
      cutoff: '2026-11-11', cutoffTime: '14:00', delivery: '2026-11-12', coversThrough: '2026-11-16', windowStart: '2026-11-11', windowEnd: '2026-11-15',
    };
    expect(nextOrderFor({ id: 's', name: 'S', deliveries: [thursday, monday] }, TUESDAY, 600)).toEqual(expected);
    expect(nextOrderFor({ id: 's', name: 'S', deliveries: [monday, thursday] }, TUESDAY, 600)).toEqual(expected);
  });

  describe('forecast day status (E5)', () => {
    const historyGuests = FOUR_WEEKS.map((day) => ({ date: day.date, guests: 100 }));
    const windowDays = covered('2026-11-11', '2026-11-18', () => ({})).map((day) => day.date);
    const run = (forecastGuests: Map<string, number>, closedDays: Set<string>) =>
      onlyLine(computeOrders(input({ itemSales: FOUR_WEEKS, counts: fresh(0), historyGuests, forecastGuests, closedDays })));

    it('expects no sales on a day the forecast marks closed, and says so', () => {
      const open = new Map(windowDays.filter((date) => date !== '2026-11-14').map((date) => [date, 150] as const));
      const line = run(open, new Set(['2026-11-14']));
      expect(line.mu).toBeCloseTo((7 * 15) / 10, 9);
      expect(line.why).toContain('from the last 8 weeks of sales, scaled to the guest forecast, leaving out one day the forecast marks closed.');
    });

    it('keeps the weekday mean, with no index, on a booked day', () => {
      const open = new Map(windowDays.filter((date) => date !== '2026-11-14').map((date) => [date, 150] as const));
      expect(run(open, new Set()).mu).toBeCloseTo((7 * 15 + 10) / 10, 9);
    });

    it('says scaled only when an open day’s index applied', () => {
      const line = run(new Map(), new Set(['2026-11-14']));
      expect(line.mu).toBeCloseTo(7, 9);
      expect(line.why).toContain('Expected use about 7 cases over these 8 days, from the last 8 weeks of sales, leaving out one day the forecast marks closed.');
      expect(line.why).not.toContain('scaled');
    });
  });

  it('asks for a count only for a count 3 or more days old; with a fresh count and short history it says the history is short (E6)', () => {
    const short = covered('2026-10-21', '2026-11-09', () => ({ i1: 10 }));
    const today = onlyLine(computeOrders(input({ itemSales: short, counts: fresh(2) })));
    expect(today.confidence).toBe('medium');
    expect(today.why).toContain('Item sales cover only 20 days of the last 8 weeks, so the history is short.');
    expect(today.why).not.toContain('Count it before');
    const old = onlyLine(computeOrders(input({ itemSales: short, counts: new Map([['i1', { quantity: 2, date: '2026-11-06' }]]) })));
    expect(old.why).toContain('Count it before you send the order.');
    expect(old.why).not.toContain('history is short');
  });

  it('says it covers the expected use only when what is counted plus the order reaches it (E7)', () => {
    const short = covered('2026-10-21', '2026-11-09', () => ({ i1: 15.625 }));
    const line = onlyLine(computeOrders(input({ items: [item({ dealSize: 6 })], itemSales: short, counts: fresh(0) })));
    // mu is 12.5 with no cushion yet; the cheaper deal option, 12, is under it.
    expect(line).toMatchObject({ sigma: null, recommended: 12, alternative: 18 });
    expect(line.mu).toBeCloseTo(12.5, 9);
    expect(line.why).toContain('Too little history for a safety cushion, and with what you counted, ordering 12 (two deals of 6) falls short of the expected use.');
    expect(line.why).not.toContain('covers the expected use');
  });

  it('says the par set the quantity, never a chance, when the par floor or the par swap did (E9)', () => {
    const line = onlyLine(computeOrders(input({ items: [item({ par: 20 })], itemSales: FOUR_WEEKS, counts: fresh(0) })));
    expect(line).toMatchObject({ recommended: 20, sigma: 0 });
    expect(line.why).toContain('Ordering 20 brings your stock up to the par of 20.');
    expect(line.why).not.toContain('chance');
    const swapped = whyLine({
      delivery: '2026-11-12', coversThrough: '2026-11-16', windowDays: 5, unit: 'cases', mu: 2, scaled: false, closedDays: 0, sold: true,
      coveredDays: 56, count: { quantity: 0, date: TUESDAY }, countAgeDays: 0, confidence: 'high', sigma: 1, recommended: 12, dealSize: 6,
      target: 0.95, par: 7, setupPar: 7, byPar: true,
    });
    expect(swapped).toContain('Ordering 12 (two deals of 6) brings your stock up to the par of 7.');
  });

  it('caps a line at 999 and says so (R5)', () => {
    const heavy = covered('2026-10-13', '2026-11-09', () => ({ i1: 100 }));
    const line = onlyLine(computeOrders(input({ items: [item({ servingsPerUnit: 0.1, dealSize: 6 })], itemSales: heavy, counts: fresh(0) })));
    expect(line).toMatchObject({ recommended: 999, alternative: null });
    expect(line.mu).toBeCloseTo(8000, 6);
    expect(line.why).toMatch(/A line holds at most 999 cases, so this is 999\.$/);
  });

  it('treats a deal size of 1 as no deal size (R6)', () => {
    const fresh0 = { quantity: 0, ageDays: 0 };
    const none = quantityFor({ par: 0, count: fresh0, mu: 3, orderUpTo: 3.2, dealSize: null });
    expect(quantityFor({ par: 0, count: fresh0, mu: 3, orderUpTo: 3.2, dealSize: 1 })).toEqual(none);
    expect(none).toEqual({ recommended: 4, alternative: null, byPar: false });
    const why = whyLine({
      delivery: '2026-11-19', coversThrough: '2026-11-23', windowDays: 5, unit: 'cases', mu: 3, scaled: false, closedDays: 0, sold: true,
      coveredDays: 56, count: { quantity: 0, date: TUESDAY }, countAgeDays: 0, confidence: 'high', sigma: 0.1, recommended: 4, dealSize: 1,
      target: 0.98, par: 0, setupPar: 0, byPar: false,
    });
    expect(why).toContain('Ordering 4 aims for a 98% chance of not running out.');
  });

  it('reads enough item sales for the oldest past window’s weekday means: 182 + 6 + 56 days (E10)', () => {
    let deepest = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const today = plusDays(TUESDAY, offset);
      for (let deliveryWeekday = 0; deliveryWeekday < 7; deliveryWeekday += 1) {
        for (let cutoffWeekday = 0; cutoffWeekday < 7; cutoffWeekday += 1) {
          const [oldest] = pastWindows({ id: 's', name: 'S', deliveries: [{ deliveryWeekday, cutoffWeekday, cutoffTime: '12:00' }] }, today);
          if (oldest === undefined) continue;
          const back = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest.cutoff}T00:00:00Z`)) / 86_400_000 + 56;
          deepest = Math.max(deepest, back);
        }
      }
    }
    expect(deepest).toBe(244);
    expect(ITEM_SALES_DAYS).toBe(deepest);
  });
});

// R1: weekdayMeans and windowSigma read one array per item instead of a map and an object per day. This is the
// straightforward version they replaced; on random data both give exactly the same numbers.
describe('the fast weekday means and sigma (R1)', () => {
  const DAY = 86_400_000;
  const dayOf = (iso: string): number => Date.parse(`${iso}T00:00:00.000Z`) / DAY;
  const weekdayOfDay = (day: number): number => (day + 4) % 7;
  const meanOf = (values: readonly number[]): number | null =>
    (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

  function referenceMeans(sales: SalesIndex, itemId: string, asOf: string): (number | null)[] {
    const end = dayOf(asOf);
    const seen: number[][] = [[], [], [], [], [], [], []];
    for (let day = end - 56; day < end; day += 1) {
      const items = sales.get(day);
      if (items !== undefined) seen[weekdayOfDay(day)]?.push(items[itemId] ?? 0);
    }
    return seen.map(meanOf);
  }

  function referenceSigma(sales: SalesIndex, itemId: string, windows: readonly PastWindow[]): number | null {
    const errors: number[] = [];
    for (const window of windows) {
      const means = referenceMeans(sales, itemId, window.cutoff);
      let forecast = 0;
      let actual = 0;
      let used = 0;
      for (let day = dayOf(window.cutoff); day <= dayOf(window.end); day += 1) {
        const items = sales.get(day);
        const expected = means[weekdayOfDay(day)] ?? null;
        if (items === undefined || expected === null) continue;
        forecast += expected;
        actual += items[itemId] ?? 0;
        used += 1;
      }
      if (used > 0) errors.push(actual - forecast);
    }
    const average = meanOf(errors);
    if (average === null || errors.length < 2) return null;
    return Math.sqrt(errors.reduce((sum, error) => sum + (error - average) ** 2, 0) / (errors.length - 1));
  }

  /** mulberry32: the same random history on every run. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  it('gives exactly the reference’s numbers on random histories with gaps and fractional servings', () => {
    const next = random(68);
    const items = ['a', 'b', 'c', 'd'];
    for (let trial = 0; trial < 25; trial += 1) {
      const days: ItemSalesDay[] = [];
      for (let date = '2026-03-01'; date < TUESDAY; date = plusDays(date, 1)) {
        if (next() < 0.2) continue;
        // Raw doubles, so a sum taken in another order would show in the last bits.
        const sold = Object.fromEntries(items.flatMap((id) => (next() < 0.3 ? [] : [[id, next() * 100]])));
        days.push({ date, items: sold });
      }
      const sales = indexSales(days);
      const deliveries = [0, 1, 2, 3, 4, 5, 6].filter(() => next() < 0.5).map((deliveryWeekday) => ({
        deliveryWeekday, cutoffWeekday: Math.floor(next() * 7), cutoffTime: '14:00',
      }));
      const windows = pastWindows({ id: 's', name: 'S', deliveries }, TUESDAY);
      for (const id of [...items, 'never-sold']) {
        for (const asOf of [TUESDAY, '2026-09-30', '2026-05-02', '2026-03-01']) {
          expect(weekdayMeans(sales, id, asOf)).toEqual(referenceMeans(sales, id, asOf));
        }
        expect(windowSigma(sales, id, windows)).toEqual(referenceSigma(sales, id, windows));
      }
    }
  });
});
