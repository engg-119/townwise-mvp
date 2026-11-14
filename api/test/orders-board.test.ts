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
    why: 'Thursday’s delivery covers through Monday.',
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
    expect(deadline(PLAN)).toBe('Order by Wed, Nov 18, 2:00pm. Thursday’s delivery covers through Monday.');
    expect(deadline({ ...PLAN, cutoffTime: '17:00' })).toBe('Order by Wed, Nov 18, 5:00pm. Thursday’s delivery covers through Monday.');
  });

  it('schedules the next Wednesday, Thursday delivery, and the Monday it covers through', () => {
    expect(sampleSchedule('2026-11-11')).toEqual({ cutoff: '2026-11-11', delivery: '2026-11-12', coversThrough: '2026-11-16' });
    expect(sampleSchedule('2026-11-12')).toEqual({ cutoff: '2026-11-18', delivery: '2026-11-19', coversThrough: '2026-11-23' });
  });

  it('labels the preview: an order per sample supplier, every line at the par with low confidence', () => {
    const board = sampleBoard('2026-11-11');
    expect(board.sample).toBe(true);
    expect(board.orders.map((order) => [order.supplier, order.lines.map((line) => line.name)])).toEqual([
      ['Sample brewery', ['Sample keg']],
      ['Sample distributor', ['Sample lager', 'Sample seltzer']],
    ]);
    for (const order of board.orders) {
      expect(order).toMatchObject({ cutoff: '2026-11-11', cutoffTime: '14:00', delivery: '2026-11-12', coversThrough: '2026-11-16' });
      expect(order.deadline).toBe('Order by Wed, Nov 11, 2:00pm. Thursday’s delivery covers through Monday.');
      for (const line of order.lines) {
        expect(line).toMatchObject({ sample: true, confidence: 'low', mu: null, sigma: null, orderUpTo: null, edit: null, rules: [] });
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
    const sample = sampleBoard('2026-11-11');
    const touched = withPreferences(
      sample,
      [{ itemId: 'sample-lager', delivery: '2026-11-12', quantity: 10, reason: 'a football weekend' }],
      [{ id: 'r1', itemId: 'sample-lager', delta: 2, situation: 'a football weekend', off: false }],
    );
    expect(touched).toBe(sample);
  });

  it('shows the latest edit for the order’s own delivery only, and the edit does not move the quantity', () => {
    const board = liveBoard([PLAN], []);
    const edited = withPreferences(board, [
      { itemId: 'lager', delivery: '2026-11-19', quantity: 6, reason: 'newest' },
      { itemId: 'lager', delivery: '2026-11-19', quantity: 5, reason: 'older' },
      { itemId: 'seltzer', delivery: '2026-11-12', quantity: 4, reason: 'last week' },
    ], []);
    expect(lineOf(edited, 'lager')).toMatchObject({ recommended: 3, edit: { quantity: 6, reason: 'newest' }, rules: [] });
    expect(lineOf(edited, 'seltzer')).toMatchObject({ recommended: 1, edit: null });
  });

  it('applies every active rule of an item, lists each with its own id, and never goes below 0', () => {
    const board = liveBoard([PLAN], []);
    const ruled = withPreferences(board, [], [
      { id: 'r1', itemId: 'lager', delta: 2, situation: 'a football weekend', off: false },
      { id: 'r2', itemId: 'lager', delta: -1, situation: 'the patio is closed.', off: false },
      { id: 'r3', itemId: 'lager', delta: 5, situation: 'an old rule', off: true },
      { id: 'r4', itemId: 'seltzer', delta: -3, situation: 'nobody drinks it', off: false },
    ]);
    const lager = lineOf(ruled, 'lager');
    expect(lager?.recommended).toBe(4);
    expect(lager?.rules).toEqual([
      { id: 'r1', delta: 2, situation: 'a football weekend' },
      { id: 'r2', delta: -1, situation: 'the patio is closed.' },
    ]);
    expect(lager?.why).toBe('Thursday’s delivery covers through Monday. Includes 2 extra cases from your rule: a football weekend. '
      + 'Leaves out 1 case from your rule: the patio is closed.');
    const seltzer = lineOf(ruled, 'seltzer');
    expect(seltzer).toMatchObject({ recommended: 0, rules: [{ id: 'r4', delta: -3, situation: 'nobody drinks it' }] });
  });

  it('finds a line by delivery and item, and never invents one', () => {
    const board = liveBoard([PLAN], []);
    expect(findLine(board, '2026-11-19', 'lager')?.line.name).toBe('Lager');
    expect(findLine(board, '2026-11-19', 'lager')?.order.supplierId).toBe(PLAN.supplierId);
    expect(findLine(board, '2026-11-26', 'lager')).toBeNull();
    expect(findLine(board, '2026-11-19', 'sample-lager')).toBeNull();
  });
});
