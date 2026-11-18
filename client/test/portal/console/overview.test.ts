import type { z } from 'zod';

import type { ApiClient } from '../../../src/api/client';
import { fetchOverview } from '../../../src/portal/console/api';
import {
  accuracyWords, activitySummary, attentionLines, changeWords, forecastWords, GROUP_LABEL, overviewDaysOf, overviewHref, recordingLine,
  spendWords, tilesOf, usd,
} from '../../../src/portal/console/overview';
import { ACTION_GROUPS, overviewSchema, type Overview } from '../../../src/portal/console/schemas';
import { formatDate } from '../../../src/portal/format';
import { overviewAnswer, overviewOrg } from './fixtures';

// The staff Overview's schema (src/portal/console/schemas.ts) and words (src/portal/console/overview.ts): openspec change
// staff-overview, design decisions 4 to 7.

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

function overview(days = 28, extra?: Record<string, unknown>): Overview {
  return overviewSchema.parse(overviewAnswer(days, extra));
}

describe('the window', () => {
  test('is 7, 28 or 90 from ?days=, and 28 for anything else', () => {
    expect(overviewDaysOf('7')).toBe(7);
    expect(overviewDaysOf('90')).toBe(90);
    expect(overviewDaysOf(undefined)).toBe(28);
    expect(overviewDaysOf('10')).toBe(28);
    expect(overviewDaysOf(['7', '90'])).toBe(28);
    expect(overviewHref(7)).toBe('/admin/overview?days=7');
  });
});

describe('the tiles', () => {
  test('say each change against the window before in words, never by color', () => {
    expect(changeWords(9, 6, 28)).toBe('Up 3 from the 28 days before');
    expect(changeWords(12, 12, 7)).toBe('Same as the 7 days before');
    expect(changeWords(3, 5, 90)).toBe('Down 2 from the 90 days before');
    expect(changeWords(4, null, 28)).toBe('No earlier days recorded');
    expect(changeWords(1200, 0, 28)).toBe('Up 1,200 from the 28 days before');
  });

  test('are the six totals, in order, with “of” for the activity figures', () => {
    expect(tilesOf(overview()).map((tile) => [tile.label, tile.value, tile.of, tile.change])).toEqual([
      ['Active organizations', '4', 'of 6', 'Up 1 from the 28 days before'],
      ['Active people', '9', 'of 14', 'Up 3 from the 28 days before'],
      ['TownwiseAI turns', '12', null, 'Same as the 28 days before'],
      ['Sales uploads', '3', null, 'Down 2 from the 28 days before'],
      ['Notes written', '7', null, 'Up 5 from the 28 days before'],
      ['Order decisions', '1', null, 'Up 1 from the 28 days before'],
    ]);
  });

  test('say plainly when nothing is recorded yet, and from when days are recorded otherwise', () => {
    expect(recordingLine(null)).toMatch(/^No activity is recorded yet\. Active people and organizations count from the first day/);
    expect(recordingLine('2026-06-01')).toBe('Active days recorded since Jun 1, 2026. Days are UTC.');
  });
});

describe('Needs attention', () => {
  const at = '2026-11-12T15:00:00.000Z';
  const item = (kind: string, extra?: Record<string, unknown>) => ({ kind, orgId: null, requestId: null, count: null, since: null, ...extra });
  const lines = (items: unknown[]) => attentionLines(overview(28, { attention: items }));

  test('writes each kind in plain words with a link to where it is acted on, from the answer’s ids and names', () => {
    const shown = lines([
      item('request_waiting', { requestId: 'r 1', since: at }),
      item('refresh_off'),
      item('refresh_paused', { since: at }),
      item('refresh_failed', { orgId: 'o1', count: 2, since: at }),
      item('no_recent_upload', { orgId: 'o1', since: at }),
      item('no_recent_upload', { orgId: 'o2' }),
      item('in_setup', { orgId: 'o2', since: at }),
      item('invites_waiting', { orgId: 'o2', count: 2, since: at }),
      item('invites_waiting', { orgId: 'o1', count: 1, since: at }),
      item('chat_budget', { orgId: 'o1' }),
    ]);
    const day = formatDate(at);
    expect(shown.map((line) => [line.text, line.link?.label ?? null, line.link?.href ?? null])).toEqual([
      [`An access request has waited since ${day}.`, 'Open the request', '/admin?request=r%201'],
      ['The weekly refresh isn’t running on this server: the forecast lab or its switch is off.', null, null],
      [`Staff paused the weekly refresh on ${day}.`, 'Open organizations', '/admin/orgs'],
      [`Sample Mountain Tavern’s weekly refresh failed at 2 locations, the first on ${day}.`, 'Open Sample Mountain Tavern', '/admin/orgs/o1'],
      [`Sample Mountain Tavern has had no upload since ${day}.`, 'Open Sample Mountain Tavern', '/admin/orgs/o1'],
      ['Sample Campus Pub has never uploaded sales.', 'Open Sample Campus Pub', '/admin/orgs/o2'],
      [`Sample Campus Pub has been in staff setup since ${day}.`, 'Open Sample Campus Pub', '/admin/orgs/o2'],
      [`2 invitations to Sample Campus Pub are unanswered, the oldest since ${day}.`, 'Open Sample Campus Pub', '/admin/orgs/o2'],
      [`1 invitation to Sample Mountain Tavern is unanswered since ${day}.`, 'Open Sample Mountain Tavern', '/admin/orgs/o1'],
      // $4.10 of $20.
      ['Sample Mountain Tavern has used 20% of this month’s TownwiseAI budget.', 'Open Sample Mountain Tavern', '/admin/orgs/o1'],
    ]);
  });

  test('skips a kind this client does not know, and names an organization the rows lack plainly', () => {
    const shown = lines([item('something_new', { orgId: 'o1' }), item('in_setup', { orgId: 'o9' })]);
    expect(shown.map((line) => [line.text, line.link?.label])).toEqual([['An organization is in staff setup.', 'Open the organization']]);
  });
});

describe('the organizations’ words', () => {
  test('money as dollars, whole dollars without cents', () => {
    expect(usd(4_100_000)).toBe('$4.10');
    expect(usd(20_000_000)).toBe('$20');
    expect(usd(0)).toBe('$0');
    expect(usd(1_234_567_890)).toBe('$1,234.57');
    expect(spendWords({ spentMicroUsd: 4_100_000, budgetMicroUsd: 20_000_000 })).toBe('$4.10 of $20');
    expect(spendWords({ spentMicroUsd: 0, budgetMicroUsd: 0 })).toBe('$0, no budget');
  });

  test('a published forecast’s live accuracy as a typical error with its day counts, never a guest count', () => {
    expect(accuracyWords({ days: 21, inRange: 17, typicalErrorPct: 12.4 })).toBe('Typical error 12.4% over 21 days, 17 in range');
    expect(accuracyWords({ days: 3, inRange: 2, typicalErrorPct: null })).toBe('3 scored days, too few for a typical error, 2 in range');
    expect(accuracyWords(null)).toBe('No scored days yet');
  });

  test('a location’s forecast names the newest run used in the window, which may not be the newest published', () => {
    const [org] = overview().orgs;
    const location = org?.locations[0];
    if (location === undefined) throw new Error('no location');
    expect(forecastWords(location)).toBe(
      `Newest run used: made ${formatDate('2026-11-09T08:00:00.000Z')}, model, data through Nov 8, 2026. Typical error 12.4% over 21 days, 17 in range`,
    );
    expect(forecastWords({ ...location, newestRun: null, accuracy: null })).toBe('No published forecast on these days');
  });
});

describe('activity by day', () => {
  test('names the groups in the chart’s order', () => {
    expect(ACTION_GROUPS.map((group) => GROUP_LABEL[group])).toEqual([
      'Uploads and data', 'Notes, rules and calendars', 'TownwiseAI', 'Orders', 'Team and settings',
    ]);
  });

  test('sums the window’s actions by group and names the busiest day', () => {
    const { series } = overview(7);
    expect(activitySummary(series, 7)).toBe(
      '9 actions recorded in the last 7 days (UTC): 2 Uploads and data, 4 Notes, rules and calendars, 1 TownwiseAI, 1 Orders, 1 Team and settings. The most people active on one day: 5, on Nov 16, 2026.',
    );
    const quiet = series.map((day) => ({ ...day, activePeople: 0, actions: { uploads: 0, notes: 0, townwiseAi: 0, orders: 0, team: 0 } }));
    expect(activitySummary(quiet, 7)).toBe('No one was active and no actions were recorded in the last 7 days (UTC).');
  });
});
