// A guest count marked wrong (D67): trustedGuestDays reads a marked day as a day with sales and no guest count, so it is
// never likely closed and never feeds a neighbor's typical guests. Synthetic days only.
import { describe, expect, it } from 'vitest';

import { closureOf, isClosure, isWrongGuestCount, notesDecide, saysOpen, trustedGuestDays, typicalByDate } from '../src/closed-days.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';

type Mark = Pick<NoteContent, 'startDate' | 'endDate' | 'weekdays' | 'effect'>;

const mark = (startDate: string, endDate = startDate, weekdays: number[] | null = null): Mark => ({
  startDate, endDate, weekdays, effect: 'wrong_guest_count',
});

const day = (date: string, guests: number | null, netSalesCents: number | null = 100_000): SalesDay => ({ date, guests, netSalesCents });

describe('isWrongGuestCount', () => {
  it('is the effect wrong_guest_count only, and decides nothing about open or closed', () => {
    const entry = { kind: 'other' as const, effect: 'wrong_guest_count' as const };
    expect(isWrongGuestCount(entry)).toBe(true);
    expect(isWrongGuestCount({ effect: 'fewer_guests' })).toBe(false);
    expect(isClosure(entry)).toBe(false);
    expect(saysOpen(entry)).toBe(false);
    expect(notesDecide([entry])).toBe(false);
  });
});

describe('trustedGuestDays', () => {
  const days = [day('2025-10-30', 90), day('2025-10-31', 80), day('2025-11-01', 70), day('2025-11-02', 60)];

  it('sets guests null on every covered date and keeps the sales', () => {
    const trusted = trustedGuestDays(days, [mark('2025-10-31', '2025-11-01')]);
    expect(trusted).toEqual([day('2025-10-30', 90), day('2025-10-31', null), day('2025-11-01', null), day('2025-11-02', 60)]);
    expect(days[1]?.guests).toBe(80);
  });

  it('respects the weekdays', () => {
    // 2025-10-31 is a Friday (5), 2025-11-01 a Saturday (6).
    const trusted = trustedGuestDays(days, [mark('2025-10-01', '2025-11-30', [6])]);
    expect(trusted.map((each) => each.guests)).toEqual([90, 80, null, 60]);
  });

  it('answers the same array when no note marks a count', () => {
    expect(trustedGuestDays(days, [])).toBe(days);
    expect(trustedGuestDays(days, [{ ...mark('2025-10-31'), effect: 'fewer_guests' }])).toBe(days);
  });

  it('keeps any other field of the day', () => {
    const rows = [{ date: '2025-10-31', guests: 80, netSalesCents: 1, extra: 'kept' }];
    expect(trustedGuestDays(rows, [mark('2025-10-31')])).toEqual([{ date: '2025-10-31', guests: null, netSalesCents: 1, extra: 'kept' }]);
  });

  it('makes a marked zero-count day with sales neither closed nor likely closed', () => {
    const history = [day('2025-10-03', 100), day('2025-10-10', 100), day('2025-10-17', 100), day('2025-10-24', 100), day('2025-10-31', 0)];
    const stored = typicalByDate(history);
    expect(closureOf(history[4], stored.get('2025-10-31') ?? null, [])).toBe('likely_closed');
    const trusted = trustedGuestDays(history, [mark('2025-10-31')]);
    const typical = typicalByDate(trusted);
    expect(closureOf(trusted[4], typical.get('2025-10-31') ?? null, [mark('2025-10-31')].map((each) => ({ ...each, kind: 'other' as const }))))
      .toBeNull();
  });

  it('leaves a marked day out of a neighbor’s typical guests', () => {
    const history = [day('2025-10-10', 100), day('2025-10-17', 110), day('2025-10-24', 120), day('2025-10-31', 1000), day('2025-11-07', 50)];
    expect(typicalByDate(history).get('2025-11-07')).toBe(115);
    expect(typicalByDate(trustedGuestDays(history, [mark('2025-10-31')])).get('2025-11-07')).toBe(110);
  });
});
