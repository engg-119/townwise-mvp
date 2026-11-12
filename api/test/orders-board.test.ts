import { describe, expect, it } from 'vitest';

import { liveBoard, sampleBoard, sampleSchedule, unavailable, withPreferences, type OrderBoard } from '../src/orders/board.ts';

describe('order board', () => {
  it('schedules the next Wednesday, Thursday delivery, and the Monday it covers through', () => {
    expect(sampleSchedule('2026-11-11')).toEqual({ cutoff: '2026-11-11', delivery: '2026-11-12', coversThrough: '2026-11-16' });
    expect(sampleSchedule('2026-11-12')).toEqual({ cutoff: '2026-11-18', delivery: '2026-11-19', coversThrough: '2026-11-23' });
  });

  it('labels the preview and keeps every line at the par with low confidence', () => {
    const board = sampleBoard('2026-11-11');
    expect(board.sample).toBe(true);
    expect(board.lines.map((line) => line.name)).toEqual(['Sample keg', 'Sample lager', 'Sample seltzer']);
    for (const line of board.lines) {
      expect(line.sample).toBe(true);
      expect(line.confidence).toBe('low');
      expect(line.recommended).toBe(line.par);
      expect(line.mu).toBeNull();
      expect(line.sigma).toBeNull();
    }
    expect(board.deadline).toContain('Wed, Nov 11');
    expect(board.deadline).toContain('2:00pm');
  });

  it('has no live board, and says what is missing', () => {
    expect(liveBoard()).toBeNull();
    expect(unavailable().available).toBe(false);
    expect(unavailable().reason).toContain('item sales');
  });

  it('leaves a sample unchanged and applies a confirmed rule only to a later line', () => {
    const sample = sampleBoard('2026-11-11');
    const touched = withPreferences(
      sample,
      [{ itemId: 'sample-lager', delivery: sample.delivery, quantity: 10, reason: 'a football weekend' }],
      [{ id: 'r1', itemId: 'sample-lager', delta: 2, situation: 'a football weekend', off: false }],
    );
    expect(touched.lines.find((line) => line.itemId === 'sample-lager')?.recommended).toBe(8);

    const live: OrderBoard = {
      ...sample,
      sample: false,
      lines: sample.lines.map((line) => ({ ...line, sample: false })),
    };
    const edited = withPreferences(
      live,
      [{ itemId: 'sample-lager', delivery: live.delivery, quantity: 10, reason: 'a football weekend' }],
      [],
    );
    const lager = edited.lines.find((line) => line.itemId === 'sample-lager');
    expect(lager?.recommended).toBe(8);
    expect(lager?.edit).toEqual({ quantity: 10, reason: 'a football weekend' });

    const ruled = withPreferences(
      live,
      [],
      [{ id: 'r1', itemId: 'sample-lager', delta: 2, situation: 'a football weekend', off: false }],
    );
    const changed = ruled.lines.find((line) => line.itemId === 'sample-lager');
    expect(changed?.recommended).toBe(10);
    expect(changed?.why).toContain('Includes 2 extra cases because a football weekend');
  });
});
