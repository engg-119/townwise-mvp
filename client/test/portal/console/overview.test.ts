import type { z } from 'zod';

import type { ApiClient } from '../../../src/api/client';
import { fetchOverview } from '../../../src/portal/console/api';
import { overviewSchema } from '../../../src/portal/console/schemas';
import { overviewAnswer, overviewOrg } from './fixtures';

// The staff Overview's schema (src/portal/console/schemas.ts, openspec change staff-overview, design decisions 4 and 6).

describe('the overview schema', () => {
  test('keeps the answer’s fields and strips unknown keys, inside accuracy too, so nothing else reaches a screen (D7)', () => {
    const location = {
      id: 'l1', name: 'Hanover', newestRun: { dataThrough: '2026-11-08', madeAt: '2026-11-09T08:00:00.000Z', engine: 'model', guests: 412 },
      accuracy: { days: 21, inRange: 17, typicalErrorPct: 12.4, from: '2026-10-20', to: '2026-11-16', guests: 999 },
      refresh: { week: '2026-11-16', outcome: 'started' }, lastScheduled: 'live', netSales: 5000,
    };
    const answer = {
      ...overviewAnswer(7),
      schedule: { running: true, paused: { at: '2026-11-10T15:00:00.000Z', email: 'staff@example.com' } },
      orgs: [overviewOrg('o1', 'Sample Mountain Tavern', { locations: [location], members: ['owner@example.com'] })],
      attention: [{ kind: 'request_waiting', orgId: null, requestId: 'r1', count: null, since: '2026-11-12T15:00:00.000Z', email: 'x@example.com' }],
      sales: [{ day: '2026-11-16', netSales: 5000 }],
    };
    const parsed = overviewSchema.parse(answer);
    expect(Object.keys(parsed).sort()).toEqual(['attention', 'orgs', 'recordingSince', 'series', 'totals', 'window']);
    const [org] = parsed.orgs;
    expect(org === undefined ? [] : Object.keys(org).sort()).toEqual([
      'actions', 'activePeople', 'chat', 'forecastsOn', 'id', 'inSetup', 'lastActiveDay', 'lastUploadAt', 'locations', 'name', 'salesDayCount', 'status',
    ]);
    expect(org?.locations).toEqual([{
      id: 'l1', name: 'Hanover', newestRun: { dataThrough: '2026-11-08', madeAt: '2026-11-09T08:00:00.000Z', engine: 'model' },
      accuracy: { days: 21, inRange: 17, typicalErrorPct: 12.4 }, refresh: { week: '2026-11-16', outcome: 'started' }, lastScheduled: 'live',
    }]);
    expect(parsed.attention).toEqual([{ kind: 'request_waiting', orgId: null, requestId: 'r1', count: null, since: '2026-11-12T15:00:00.000Z' }]);
    expect(JSON.stringify(parsed)).not.toMatch(/example\.com|guests|netSales|5000|999|412/);
  });

  test('reads an answer with nothing recorded and no forecast', () => {
    const parsed = overviewSchema.parse(overviewAnswer(7, {
      recordingSince: null,
      totals: {
        activeOrgs: { count: 0, previous: null, of: 0 }, activePeople: { count: 0, previous: null, of: 0 },
        chatTurns: { count: 0, previous: 0 }, salesUploads: { count: 0, previous: 0 }, notesWritten: { count: 0, previous: 0 }, orderDecisions: { count: 0, previous: 0 },
      },
      orgs: [overviewOrg('o1', 'Sample Inn', { lastActiveDay: null, lastUploadAt: null, locations: [{
        id: 'l1', name: 'Hanover', newestRun: null, accuracy: null, refresh: null, lastScheduled: null,
      }] })],
    }));
    expect(parsed.recordingSince).toBeNull();
    expect(parsed.totals.activePeople.previous).toBeNull();
    expect(parsed.orgs[0]?.locations[0]?.newestRun).toBeNull();
  });
});

test('fetchOverview reads GET /api/admin/overview with the window in days', async () => {
  const paths: string[] = [];
  const api = {
    json<T>(path: string, schema: z.ZodType<T>): Promise<T> {
      paths.push(path);
      return Promise.resolve(schema.parse(overviewAnswer(90)));
    },
  } as unknown as ApiClient;
  const answer = await fetchOverview(api, 90);
  expect(paths).toEqual(['/api/admin/overview?days=90']);
  expect(answer.window.days).toBe(90);
  expect(answer.series).toHaveLength(90);
});
