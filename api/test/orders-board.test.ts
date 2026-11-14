import { describe, expect, it } from 'vitest';

import {
  deadline, findLine, liveBoard, sampleBoard, sampleSchedule, unavailable, withPreferences, type OrderBoard, type OrderLine,
} from '../src/orders/board.ts';
import { clockTime, shortDate } from '../src/orders/dates.ts';
import type { EngineLine, SupplierOrderPlan } from '../src/orders/engine.ts';

function engineLine(itemId: string, name: string, recommended: number): EngineLine {
  return {
    itemId, name, supplier: 'North Distributing', unit: 'cases', neverRunOut: false, recommended, alternative: null, par: 2, mu: 3.5,
    sigma: null, orderUpTo: 3.5, target: 0.95, onHand: 1, countAgeDays: 0, confidence: 'high', dealSize: null, coveredDays: 56,
    why: 'Thursday’s delivery lasts until Monday’s.',
  };
}

const PLAN: SupplierOrderPlan = {
  supplierId: 'a'.repeat(24), supplier: 'North Distributing', cutoff: '2026-11-18', cutoffTime: '14:00', delivery: '2026-11-19',
  coversThrough: '2026-11-23', windowStart: '2026-11-18', windowEnd: '2026-11-22',
  lines: [engineLine('lager', 'Lager', 3), engineLine('seltzer', 'Seltzer', 1)],
};

function lineOf(board: OrderBoard, itemId: string): OrderLine | undefined {
  return board.orders.flatMap((order) => order.lines).find((line) => line.itemId === itemId);
}

describe('order board', () => {
  it('words dates and order-by times', () => {
    expect(shortDate('2026-11-18')).toBe('Wed, Nov 18');
    expect(['00:30', '09:05', '12:00', '14:00', '23:59'].map(clockTime)).toEqual(['12:30am', '9:05am', '12:00pm', '2:00pm', '11:59pm']);
    expect(deadline(PLAN)).toBe('Order by Wed, Nov 18, 2:00pm. Thursday’s delivery lasts until Monday’s.');
    expect(deadline({ ...PLAN, cutoffTime: '17:00' })).toBe('Order by Wed, Nov 18, 5:00pm. Thursday’s delivery lasts until Monday’s.');
  });

  it('schedules the next Wednesday, Thursday delivery, and the Monday it covers through', () => {
    expect(sampleSchedule('2026-11-11', 9 * 60)).toEqual({ cutoff: '2026-11-11', delivery: '2026-11-12', coversThrough: '2026-11-16' });
    expect(sampleSchedule('2026-11-12', 9 * 60)).toEqual({ cutoff: '2026-11-18', delivery: '2026-11-19', coversThrough: '2026-11-23' });
  });

  it('rolls the sample past Wednesday once its 2:00pm order-by has passed (E12)', () => {
    expect(sampleSchedule('2026-11-11', 13 * 60 + 59).cutoff).toBe('2026-11-11');
    expect(sampleSchedule('2026-11-11', 14 * 60)).toEqual({ cutoff: '2026-11-18', delivery: '2026-11-19', coversThrough: '2026-11-23' });
    expect(sampleBoard('2026-11-11', 15 * 60).orders[0]?.cutoff).toBe('2026-11-18');
  });

  it('labels the preview: an order per sample supplier, every line at the par with low confidence and no other deal', () => {
    const board = sampleBoard('2026-11-11', 9 * 60);
    expect(board.sample).toBe(true);
    expect(board.orders.map((order) => [order.supplier, order.lines.map((line) => line.name)])).toEqual([
      ['Sample brewery', ['Sample keg']],
      ['Sample distributor', ['Sample lager', 'Sample seltzer']],
    ]);
    for (const order of board.orders) {
      expect(order).toMatchObject({ cutoff: '2026-11-11', cutoffTime: '14:00', delivery: '2026-11-12', coversThrough: '2026-11-16' });
      expect(order.deadline).toBe('Order by Wed, Nov 11, 2:00pm. Thursday’s delivery lasts until Monday’s.');
      for (const line of order.lines) {
        expect(line).toMatchObject({
          sample: true, confidence: 'low', mu: null, sigma: null, orderUpTo: null, dealSize: null, alternative: null, edit: null, rules: [],
        });
        expect(line.recommended).toBe(line.par);
        expect(line.supplier).toBe(order.supplier);
      }
    }
  });

  it('is unavailable with what the setup lacks', () => {
    const answer = unavailable(['the supplier schedule', 'the items']);
    expect(answer).toMatchObject({ available: false, missing: ['the supplier schedule', 'the items'] });
    expect(answer.reason).toContain('supplier schedule');
  });

  it('builds the live board from the engine’s plans, one order per supplier with its deadline', () => {
    const board = liveBoard([PLAN], ['a recent count']);
    expect(board).toEqual({
      available: true, sample: false, missing: ['a recent count'],
      orders: [{
        supplierId: PLAN.supplierId, supplier: PLAN.supplier, cutoff: PLAN.cutoff, cutoffTime: PLAN.cutoffTime, delivery: PLAN.delivery,
        coversThrough: PLAN.coversThrough, deadline: deadline(PLAN),
        lines: PLAN.lines.map((line) => ({ ...line, sample: false, edit: null, rules: [] })),
      }],
    });
  });

  it('leaves a sample unchanged by edits and rules', () => {
    const sample = sampleBoard('2026-11-11', 9 * 60);
    const touched = withPreferences(
      sample,
      [{ itemId: 'sample-lager', delivery: '2026-11-12', quantity: 10, unit: 'cases', reason: 'a football weekend' }],
      [{ id: 'r1', itemId: 'sample-lager', delta: 2, unit: 'cases', situation: 'a football weekend', off: false }],
    );
    expect(touched).toBe(sample);
  });

  it('shows the latest edit for the order’s own delivery only, and the edit does not move the quantity', () => {
    const board = liveBoard([PLAN], []);
    const edited = withPreferences(board, [
      { itemId: 'lager', delivery: '2026-11-19', quantity: 6, unit: 'cases', reason: 'newest' },
      { itemId: 'lager', delivery: '2026-11-19', quantity: 5, unit: 'cases', reason: 'older' },
      { itemId: 'seltzer', delivery: '2026-11-12', quantity: 4, unit: 'cases', reason: 'last week' },
    ], []);
    expect(lineOf(edited, 'lager')).toMatchObject({ recommended: 3, edit: { quantity: 6, reason: 'newest' }, rules: [] });
    expect(lineOf(edited, 'seltzer')).toMatchObject({ recommended: 1, edit: null });
  });

  it('applies every active rule of an item, lists each with its own id, and never goes below 0', () => {
    const board = liveBoard([PLAN], []);
    const ruled = withPreferences(board, [], [
      { id: 'r1', itemId: 'lager', delta: 2, unit: 'cases', situation: 'a football weekend', off: false },
      { id: 'r2', itemId: 'lager', delta: -1, unit: 'cases', situation: 'the patio is closed.', off: false },
      { id: 'r3', itemId: 'lager', delta: 5, unit: 'cases', situation: 'an old rule', off: true },
      { id: 'r4', itemId: 'seltzer', delta: -3, unit: 'cases', situation: 'nobody drinks it', off: false },
    ]);
    const lager = lineOf(ruled, 'lager');
    expect(lager?.recommended).toBe(4);
    expect(lager?.rules).toEqual([
      { id: 'r1', delta: 2, situation: 'a football weekend' },
      { id: 'r2', delta: -1, situation: 'the patio is closed.' },
    ]);
    expect(lager?.why).toBe('Thursday’s delivery lasts until Monday’s. Includes 2 extra cases from your rule: a football weekend. '
      + 'Leaves out 1 case from your rule: the patio is closed. With your rules, the order is 4 cases.');
    const seltzer = lineOf(ruled, 'seltzer');
    expect(seltzer).toMatchObject({ recommended: 0, rules: [{ id: 'r4', delta: -3, situation: 'nobody drinks it' }] });
    expect(seltzer?.why).toBe('Thursday’s delivery lasts until Monday’s. Leaves out 3 cases from your rule: nobody drinks it. '
      + 'With your rule, the order is 0 cases: only 1 case could come off.');
  });

  it('says what a rule did when 0 or 999 stopped it, and drops the other deal option a rule moved (E8, R6)', () => {
    const dealt: SupplierOrderPlan = { ...PLAN, lines: [{ ...engineLine('lager', 'Lager', 3), alternative: 6, dealSize: 6 }, engineLine('big', 'Big', 997)] };
    const ruled = withPreferences(liveBoard([dealt], []), [], [
      { id: 'r1', itemId: 'lager', delta: -5, unit: 'cases', situation: 'slow week', off: false },
      { id: 'r2', itemId: 'big', delta: 5, unit: 'cases', situation: 'a festival', off: false },
    ]);
    expect(lineOf(ruled, 'lager')).toMatchObject({ recommended: 0, alternative: null });
    expect(lineOf(ruled, 'lager')?.why).toBe('Thursday’s delivery lasts until Monday’s. Leaves out 5 cases from your rule: slow week. '
      + 'With your rule, the order is 0 cases: only 3 cases could come off.');
    expect(lineOf(ruled, 'big')).toMatchObject({ recommended: 999, alternative: null });
    expect(lineOf(ruled, 'big')?.why).toContain('Includes 5 extra cases from your rule: a festival. With your rule, the order is 999 cases: a line holds at most 999.');
    // With no rule the other deal option stays.
    expect(lineOf(withPreferences(liveBoard([dealt], []), [], []), 'lager')).toMatchObject({ recommended: 3, alternative: 6 });
  });

  it('leaves out an edit or a rule saved in another unit than the line’s now (A2)', () => {
    // The setup changed the item from cases to bottles after the edit and the rule were saved.
    const bottles: SupplierOrderPlan = { ...PLAN, lines: [{ ...engineLine('lager', 'Lager', 3), unit: 'bottles' }] };
    const board = withPreferences(
      liveBoard([bottles], []),
      [{ itemId: 'lager', delivery: '2026-11-19', quantity: 6, unit: 'cases', reason: 'in cases' }],
      [
        { id: 'r1', itemId: 'lager', delta: 2, unit: 'cases', situation: 'in cases', off: false },
        { id: 'r2', itemId: 'lager', delta: 12, unit: 'bottles', situation: 'in bottles', off: false },
      ],
    );
    expect(lineOf(board, 'lager')).toMatchObject({ unit: 'bottles', recommended: 15, edit: null, rules: [{ id: 'r2', delta: 12, situation: 'in bottles' }] });
    expect(lineOf(board, 'lager')?.why).not.toContain('in cases');
  });

  it('finds a line by delivery and item, and never invents one', () => {
    const board = liveBoard([PLAN], []);
    expect(findLine(board, '2026-11-19', 'lager')?.line.name).toBe('Lager');
    expect(findLine(board, '2026-11-19', 'lager')?.order.supplierId).toBe(PLAN.supplierId);
    expect(findLine(board, '2026-11-26', 'lager')).toBeNull();
    expect(findLine(board, '2026-11-19', 'sample-lager')).toBeNull();
  });
});
