// checkStart's history rule (D42; a person's start since 2026-11-19): every start, staff's Calibrate, TownwiseAI's
// (chat, or a file it read, D34) and the weekly refresh's, needs a 230-day span from the first to the last day with
// guests, so under 595 days the lab runs the baseline alone; 229 days is not_enough_history. Who pays is unchanged: a
// spent month refuses a person's start and not the weekly refresh's. Stores are fakes; every number is synthetic.
import { describe, expect, it } from 'vitest';

import { utcDay } from '../src/dates.ts';
import { GATE } from '../src/lab/gate.ts';
import { checkStart, SYSTEM_REQUESTER, type LabStartContext, type StartRequest } from '../src/lab/service.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';

const TODAY = '2026-06-01';
const LAST = '2026-05-31';

const REQUESTERS: readonly StartRequest['requester'][] = [
  { userId: 'staff-0000', role: 'superadmin', via: 'console' },
  { userId: 'admin-0000', role: 'org_admin', via: 'chat' },
  { userId: 'admin-0000', role: 'org_admin', via: 'file' },
  { userId: 'staff-0000', role: 'superadmin', via: 'file' },
  SYSTEM_REQUESTER,
];

/** A context whose location holds a guest on every day of a `span`-day span ending LAST, with `spentMicroUsd` used this month. */
function contextWith(span: number, spentMicroUsd = 0): LabStartContext {
  const first = utcDay(new Date(`${LAST}T00:00:00.000Z`), -span);
  const days: SalesDay[] = [];
  for (let date = first; date <= LAST; date = utcDay(new Date(`${date}T00:00:00.000Z`), 1)) days.push({ date, guests: 10, netSalesCents: null });
  return {
    labRunner: { start: () => Promise.reject(new Error('checkStart never starts a job')) },
    config: { chatMonthlyBudgetUsd: 5 },
    now: () => new Date(`${TODAY}T12:00:00.000Z`),
    redis: null,
    stores: {
      salesDays: {
        coverage: () => Promise.resolve({ firstDate: first, lastDate: LAST }),
        days: () => Promise.resolve(days),
      },
      chatUsage: { costMicroUsd: () => Promise.resolve(spentMicroUsd) },
      calibrations: { live: () => Promise.resolve(null) },
    },
  } as unknown as LabStartContext;
}

function requestBy(requester: StartRequest['requester']): StartRequest {
  return {
    id: '0'.repeat(24), scope: { orgId: '1'.repeat(24) } as StartRequest['scope'], location: { id: '2'.repeat(24) } as StartRequest['location'],
    requester, regimeStart: null, today: TODAY,
  };
}

describe('checkStart’s history (D42, 2026-11-19)', () => {
  it('is the baseline’s 230 days, below the model’s 595', () => {
    expect(GATE.baselineMinHistoryDays).toBe(230);
    expect(GATE.minHistoryDays).toBe(595);
  });

  for (const requester of REQUESTERS) {
    it(`${requester.role} via ${requester.via}: 229 days is not_enough_history; 230, 594 and 595 start`, async () => {
      expect(await checkStart(contextWith(229), requestBy(requester))).toBe('not_enough_history');
      for (const span of [230, 594, 595]) expect(await checkStart(contextWith(span), requestBy(requester))).toBeNull();
    });
  }

  it('a spent month still refuses a person’s start under 595 days, never the weekly refresh’s', async () => {
    const spent = contextWith(300, 5_000_000);
    for (const requester of REQUESTERS) {
      expect(await checkStart(spent, requestBy(requester))).toBe(requester.role === 'system' ? null : 'budget_exhausted');
    }
  });
});
