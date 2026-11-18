// The active days recorder (access/activity.ts, openspec change staff-overview, design decisions 2 and 3), over a fake
// store and a stubbed old-row removal: who is recorded, one write per person per UTC day per replica, a failed write
// tried again by the next request, a new day clearing the set, and the old rows removed once a day.
import { createLogger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVITY_KEEP_DAYS, createActivityRecorder } from '../src/access/activity.ts';
import { scopeForNewOrg, type OrgScope, type Principal } from '../src/access/policy.ts';

const removal = vi.hoisted(() => ({ removeOldActivityDays: vi.fn<(connection: unknown, beforeDay: string) => Promise<number>>() }));
vi.mock('../src/stores/cross-tenant.ts', () => removal);

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const ORG = 'd'.repeat(24);
const scope = scopeForNewOrg(STAFF, ORG);
const DAY_MS = 24 * 60 * 60 * 1000;

function member(userId: string, over: Partial<Extract<Principal, { kind: 'member' }>> = {}): Principal {
  return { kind: 'member', userId, email: `${userId}@example.test`, scope, role: 'member', memberId: `seat-${userId}`, viewAs: null, openAsAdmin: null, ...over };
}

const actor = { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' };

function setup() {
  let current = Date.parse('2026-06-01T12:00:00.000Z');
  const calls: { orgId: string; userId: string; day: string }[] = [];
  const failures: unknown[] = [];
  const store = {
    record: (s: OrgScope, userId: string, day: string): Promise<void> => {
      calls.push({ orgId: s.orgId, userId, day });
      const failure = failures.shift();
      return failure === undefined ? Promise.resolve() : Promise.reject(failure instanceof Error ? failure : new Error('failed'));
    },
  };
  const logs: string[] = [];
  const logger = createLogger({ LOG_LEVEL: 'trace' }, {
    destination: { write: (message: string) => { logs.push(...message.split('\n').filter((line) => line.trim() !== '')); } },
  });
  const recorder = createActivityRecorder({
    connection: {} as Connection, activityDays: store, logger, now: () => new Date(current),
  });
  return {
    recorder, calls, failures, raw: () => logs.join('\n'),
    lines: () => logs.map((line) => JSON.parse(line) as Record<string, unknown>),
    advance: (ms: number) => { current += ms; },
  };
}

beforeEach(() => {
  removal.removeOldActivityDays.mockReset();
  removal.removeOldActivityDays.mockResolvedValue(0);
});

describe('the active days recorder', () => {
  it('writes a person who joins another organization the same day once in each', async () => {
    const t = setup();
    const other = scopeForNewOrg(STAFF, 'e'.repeat(24));
    t.recorder.record(member('u1'));
    t.recorder.record(member('u1', { scope: other }));
    t.recorder.record(member('u1', { scope: other }));
    await t.recorder.idle();
    expect(t.calls.map((call) => call.orgId)).toEqual([ORG, 'e'.repeat(24)]);
  });

  it('writes once per person per UTC day, and never for staff, view-as, open as admin or anyone without a seat', async () => {
    const t = setup();
    const principals: Principal[] = [
      { kind: 'staff', actor },
      // View-as: the target's id and seat, with the staff member as the actor.
      member('target-0001', { viewAs: { grantId: 'grant-1', actor } }),
      // Open as admin: no seat.
      member('staff-0000', { role: 'org_admin', memberId: null, openAsAdmin: { grantId: 'grant-2', actor } }),
      { kind: 'other', userId: 'pending-0001', email: 'pending@example.test', access: { state: 'no_org' }, viewAs: null },
    ];
    for (const principal of principals) t.recorder.record(principal);
    await t.recorder.idle();
    expect(t.calls).toEqual([]);
    // Nobody was recorded, so no write of the day ran yet and the old rows wait.
    expect(removal.removeOldActivityDays).not.toHaveBeenCalled();

    for (let i = 0; i < 5; i += 1) t.recorder.record(member('user-0001'));
    t.recorder.record(member('user-0002', { role: 'org_admin' }));
    await t.recorder.idle();
    expect(t.calls).toEqual([
      { orgId: ORG, userId: 'user-0001', day: '2026-06-01' },
      { orgId: ORG, userId: 'user-0002', day: '2026-06-01' },
    ]);
  });

  it('never waits for the write: record returns at once while the write is still running', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const recorder = createActivityRecorder({
      connection: {} as Connection, activityDays: { record: () => held }, logger: createLogger({ LOG_LEVEL: 'silent' }), now: () => new Date('2026-06-01T12:00:00Z'),
    });
    recorder.record(member('user-0003'));
    let idle = false;
    const waiting = recorder.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(idle).toBe(true);
  });

  it('a failed write logs townwise.activity_write_failed with the organization and code only, and the next request tries again', async () => {
    const t = setup();
    t.failures.push(Object.assign(new Error('sentinel error text user-0004@example.test'), { code: 121 }));
    t.recorder.record(member('user-0004'));
    await t.recorder.idle();
    expect(t.lines().filter((line) => line.msg === 'townwise.activity_write_failed').map(({ orgId, code }) => ({ orgId, code })))
      .toEqual([{ orgId: ORG, code: 121 }]);
    const failed = t.lines().find((line) => line.msg === 'townwise.activity_write_failed') ?? {};
    expect(Object.keys(failed).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort()).toEqual(['code', 'orgId']);
    expect(t.raw()).not.toContain('sentinel');
    expect(t.raw()).not.toContain('user-0004');

    t.recorder.record(member('user-0004'));
    t.recorder.record(member('user-0004'));
    await t.recorder.idle();
    expect(t.calls.map((call) => call.userId)).toEqual(['user-0004', 'user-0004']);
  });

  it('a new UTC day clears the set, so the same person is written again for it', async () => {
    const t = setup();
    t.recorder.record(member('user-0005'));
    t.advance(11 * 60 * 60 * 1000);
    t.recorder.record(member('user-0005'));
    t.advance(2 * 60 * 60 * 1000);
    t.recorder.record(member('user-0005'));
    t.recorder.record(member('user-0005'));
    await t.recorder.idle();
    expect(t.calls.map((call) => call.day)).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('the first write of each UTC day removes rows dated before the 180 days kept, once, and logs its count', async () => {
    expect(ACTIVITY_KEEP_DAYS).toBe(180);
    const t = setup();
    removal.removeOldActivityDays.mockResolvedValueOnce(3);
    t.recorder.record(member('user-0006'));
    t.recorder.record(member('user-0007'));
    t.recorder.record(member('user-0006'));
    await t.recorder.idle();
    // Today and the 179 days before it stay: 2025-12-04 is 179 days before 2026-06-01.
    expect(removal.removeOldActivityDays.mock.calls.map(([, day]) => day)).toEqual(['2025-12-04']);
    expect(t.lines().filter((line) => line.msg === 'townwise.activity_days_removed').map(({ deleted }) => deleted)).toEqual([3]);

    t.advance(DAY_MS);
    t.recorder.record(member('user-0006'));
    t.recorder.record(member('user-0007'));
    await t.recorder.idle();
    expect(removal.removeOldActivityDays.mock.calls.map(([, day]) => day)).toEqual(['2025-12-04', '2025-12-05']);
  });

  it('a failed removal logs its code only and never stops the day’s writes', async () => {
    const t = setup();
    removal.removeOldActivityDays.mockRejectedValueOnce(Object.assign(new Error('sentinel removal text'), { code: 'ECONNRESET' }));
    t.recorder.record(member('user-0008'));
    await t.recorder.idle();
    expect(t.calls).toHaveLength(1);
    expect(t.lines().filter((line) => line.msg === 'townwise.activity_days_remove_failed').map(({ code }) => code)).toEqual(['ECONNRESET']);
    expect(t.raw()).not.toContain('sentinel');
  });
});
