// The staff Overview's pure parts (handlers/overview.ts, openspec change staff-overview, design decisions 4 and 5): the
// action groups against every audit action, the windows and their previous-window cut-off, the folded totals and
// series, the organizations' order, and Needs attention at each threshold.
import { describe, expect, it } from 'vitest';

import {
  ACTION_GROUP, ACTION_GROUPS, attentionOf, hasPrevious, overviewWindow, RETENTION_EDGE_SLACK_DAYS, sortOrgRows, summarize,
  type AttentionFacts,
} from '../src/handlers/overview.ts';
import { AUDIT_DETAIL_KEYS, type AuditAction } from '../src/stores/audit-events.ts';

/** Design decision 4's table, row by row. */
const DESIGN_TABLE = {
  uploads: [
    'sales.uploaded', 'sales.deleted', 'sales.upload_deleted', 'data.turned_off', 'data.turned_on', 'data.renamed', 'data.edited',
    'file.uploaded', 'file.deleted', 'file.raw_deleted', 'files.raw_deleted_all', 'order.item_sales_uploaded', 'order.item_sales_deleted',
  ],
  notes: [
    'note.created', 'note.updated', 'note.deleted', 'rule.created', 'rule.updated', 'rule.deleted', 'owner_calendar.added',
    'owner_calendar.removed', 'owner_calendar.refreshed', 'google_calendar.connected', 'google_calendar.disconnected',
    'owner_calendar.booking_labeled', 'owner_calendar.bookings_confirmed',
    // D66: a person's edit, hide or restore of a researched event.
    'research.event_edited', 'research.event_hidden', 'research.event_restored',
  ],
  townwiseAi: [
    'chat.turn_completed', 'chat.conversation_deleted', 'agent.question_answered', 'agent.suggestion_accepted', 'agent.suggestion_dismissed',
    'file.ai_read_requested', 'file.ai_undone', 'order.setup_read', 'order.card_saved', 'order.card_dismissed', 'calibration.requested',
    'owner_calendar.bookings_sorted', 'agent.change_undone',
  ],
  orders: ['order.setup_saved', 'order.count_saved', 'order.decision_saved', 'order.rule_saved', 'order.rule_turned_off'],
  team: [
    'member.invited', 'member.joined', 'member.role_changed', 'member.removed', 'member.left', 'location.created', 'location.updated',
    'location.deleted', 'org.renamed', 'org.weekly_suggestions_changed', 'org.calendar_titles_ai_changed',
    'org.agent_auto_switched', 'org.research_switched',
  ],
  none: [
    'access_request.created', 'access_request.approved', 'access_request.rejected', 'access_request.withdrawn', 'org.created',
    'org.suspended', 'org.reactivated', 'org.deleted', 'member.declined', 'file.ai_read', 'org.originals_deleted', 'forecast.imported',
    'forecast.published', 'forecast.withdrawn', 'forecast.deleted', 'calibration.finished', 'calibration.scheduled',
    'org.forecasts_switched', 'forecast_schedule.paused', 'forecast_schedule.resumed', 'view_as.started', 'view_as.ended',
    'open_as_admin.started', 'open_as_admin.ended', 'people.signed_out_everywhere', 'person.deleted', 'staff_action.not_applied',
    'agent.change_applied', 'agent.calendar_answered', 'research.town_event_suppressed',
  ],
} as const;

describe('the action groups', () => {
  it('place every audit action in exactly one group or in none, so a new action fails here until it is placed', () => {
    const actions = Object.keys(AUDIT_DETAIL_KEYS).sort();
    expect(Object.keys(ACTION_GROUP).sort()).toEqual(actions);
    // The design's rows hold each action once, and together hold every action.
    const rows = Object.values(DESIGN_TABLE).flat();
    expect(new Set(rows).size).toBe(rows.length);
    expect([...rows].sort()).toEqual(actions);
  });

  it('match design decision 4’s table, row by row, in its group order', () => {
    expect(ACTION_GROUPS).toEqual(['uploads', 'notes', 'townwiseAi', 'orders', 'team']);
    for (const [group, actions] of Object.entries(DESIGN_TABLE)) {
      const placed = Object.entries(ACTION_GROUP).filter(([, each]) => (each ?? 'none') === group).map(([action]) => action).sort();
      expect({ group, placed }).toEqual({ group, placed: [...actions].sort() });
    }
  });
});

const NOW = new Date('2026-06-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('the window', () => {
  it('is the last `days` UTC days, today included, and the previous window the `days` days before it', () => {
    expect(overviewWindow(NOW, 7)).toEqual({ days: 7, from: '2026-06-09', to: '2026-06-15', previousFrom: '2026-06-02', previousTo: '2026-06-08' });
    expect(overviewWindow(NOW, 28)).toEqual({ days: 28, from: '2026-05-19', to: '2026-06-15', previousFrom: '2026-04-21', previousTo: '2026-05-18' });
    expect(overviewWindow(NOW, 90)).toEqual({ days: 90, from: '2026-03-18', to: '2026-06-15', previousFrom: '2025-12-18', previousTo: '2026-03-17' });
    // The 90-day window's previous one starts 179 days back: inside the 180 days kept.
    expect(overviewWindow(NOW, 90).previousFrom).toBe('2025-12-18');
  });

  it('has a previous value for the activity figures only when the record reaches back to the previous window’s first day', () => {
    const window = overviewWindow(NOW, 7);
    expect(hasPrevious(window, null)).toBe(false);
    expect(hasPrevious(window, '2026-06-03')).toBe(false);
    expect(hasPrevious(window, '2026-06-02')).toBe(true);
    expect(hasPrevious(window, '2026-01-01')).toBe(true);
  });

  it('treats the 90-day previous window as covered when the earliest row is within 14 days of the oldest day kept', () => {
    // 180 days kept: the oldest is 2025-12-18, the 90-day previous window's first day. A quiet day at that edge is not
    // missing recording, so an earliest row up to 14 days later (2026-01-01) still means the record covers it.
    expect(RETENTION_EDGE_SLACK_DAYS).toBe(14);
    const window = overviewWindow(NOW, 90);
    expect(hasPrevious(window, '2025-12-18')).toBe(true);
    expect(hasPrevious(window, '2025-12-25')).toBe(true);
    expect(hasPrevious(window, '2026-01-01')).toBe(true);
    expect(hasPrevious(window, '2026-01-02')).toBe(false);
    expect(hasPrevious(window, null)).toBe(false);
    // The slack is measured from the retention edge, not from a window's own first day.
    expect(hasPrevious(overviewWindow(NOW, 28), '2026-04-22')).toBe(false);
    expect(hasPrevious(overviewWindow(NOW, 7), '2026-06-03')).toBe(false);
  });

  it('gives the 90-day window a previous value through summarize when the edge day was quiet', () => {
    const window = overviewWindow(NOW, 90);
    const activity = [{ orgId: 'a'.repeat(24), userId: 'u1', day: '2025-12-24' }, { orgId: 'a'.repeat(24), userId: 'u1', day: '2026-06-15' }];
    expect(summarize(window, activity, []).totals.activePeople).toEqual({ count: 1, previous: 1 });
    const late = [{ orgId: 'a'.repeat(24), userId: 'u1', day: '2026-01-10' }];
    expect(summarize(window, late, []).totals.activePeople).toEqual({ count: 0, previous: null });
  });
});

describe('summarize', () => {
  const window = overviewWindow(NOW, 7);
  const A = 'a'.repeat(24);
  const B = 'b'.repeat(24);
  const at = (day: string, hour = 12): Date => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  const act = (orgId: string, action: AuditAction, when: Date) => ({ orgId, action, at: when });

  it('counts distinct people and organizations in each window, one series entry per day with zeros, and each action in its group', () => {
    const activity = [
      { orgId: A, userId: 'u1', day: '2026-06-15' }, { orgId: A, userId: 'u1', day: '2026-06-14' }, { orgId: A, userId: 'u2', day: '2026-06-14' },
      { orgId: B, userId: 'u3', day: '2026-06-09' },
      // The previous window, and before it.
      { orgId: A, userId: 'u1', day: '2026-06-08' }, { orgId: A, userId: 'u4', day: '2026-06-02' }, { orgId: B, userId: 'u3', day: '2026-06-01' },
    ];
    const actions = [
      act(A, 'chat.turn_completed', at('2026-06-15')), act(A, 'sales.uploaded', at('2026-06-15', 0)), act(A, 'file.uploaded', at('2026-06-14', 23)),
      act(B, 'note.created', at('2026-06-09')), act(B, 'order.decision_saved', at('2026-06-10')), act(B, 'member.invited', at('2026-06-10')),
      // Placed in no group: counted nowhere, not even the organization's actions.
      act(B, 'org.created', at('2026-06-10')),
      act(A, 'chat.turn_completed', at('2026-06-08', 23)), act(A, 'note.created', at('2026-06-02')),
      // Before the previous window: counted nowhere.
      act(A, 'note.created', at('2026-06-01')),
    ];
    const summary = summarize(window, activity, actions);
    expect(summary.recordingSince).toBe('2026-06-01');
    expect(summary.totals).toEqual({
      activeOrgs: { count: 2, previous: 1 },
      activePeople: { count: 3, previous: 2 },
      chatTurns: { count: 1, previous: 1 },
      salesUploads: { count: 1, previous: 0 },
      notesWritten: { count: 1, previous: 1 },
      orderDecisions: { count: 1, previous: 0 },
    });
    expect(summary.series.map((entry) => entry.day)).toEqual([
      '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15',
    ]);
    const zero = { uploads: 0, notes: 0, townwiseAi: 0, orders: 0, team: 0 };
    expect(summary.series).toEqual([
      { day: '2026-06-09', activePeople: 1, actions: { ...zero, notes: 1 } },
      { day: '2026-06-10', activePeople: 0, actions: { ...zero, orders: 1, team: 1 } },
      { day: '2026-06-11', activePeople: 0, actions: zero },
      { day: '2026-06-12', activePeople: 0, actions: zero },
      { day: '2026-06-13', activePeople: 0, actions: zero },
      { day: '2026-06-14', activePeople: 2, actions: { ...zero, uploads: 1 } },
      { day: '2026-06-15', activePeople: 1, actions: { ...zero, uploads: 1, townwiseAi: 1 } },
    ]);
    expect(summary.byOrg.get(A)).toEqual({ activePeople: 2, actions: 3, lastActiveDay: '2026-06-15' });
    expect(summary.byOrg.get(B)).toEqual({ activePeople: 1, actions: 3, lastActiveDay: '2026-06-09' });
  });

  it('gives no previous activity figures before the record existed, and reads nothing recorded as 0 with no earlier days', () => {
    const fresh = summarize(window, [{ orgId: A, userId: 'u1', day: '2026-06-10' }], []);
    expect(fresh.recordingSince).toBe('2026-06-10');
    expect(fresh.totals.activeOrgs).toEqual({ count: 1, previous: null });
    expect(fresh.totals.activePeople).toEqual({ count: 1, previous: null });
    expect(fresh.totals.chatTurns).toEqual({ count: 0, previous: 0 });
    const none = summarize(window, [], []);
    expect(none.recordingSince).toBeNull();
    expect(none.totals.activePeople).toEqual({ count: 0, previous: null });
    expect(none.series).toHaveLength(7);
    expect(none.byOrg.size).toBe(0);
  });

  it('keeps an organization’s last active day from before the window', () => {
    const summary = summarize(window, [{ orgId: A, userId: 'u1', day: '2026-03-01' }], []);
    expect(summary.byOrg.get(A)).toEqual({ activePeople: 0, actions: 0, lastActiveDay: '2026-03-01' });
  });
});

describe('the organizations’ order', () => {
  it('is actions in the window, most first, then name', () => {
    const rows = [
      { name: 'Birch Pub', actions: 3 }, { name: 'alder Cafe', actions: 3 }, { name: 'Cedar Grill', actions: 9 }, { name: 'Ash Diner', actions: 0 },
    ];
    expect(sortOrgRows(rows).map((row) => row.name)).toEqual(['Cedar Grill', 'alder Cafe', 'Birch Pub', 'Ash Diner']);
  });
});

describe('Needs attention', () => {
  const ORG = 'c'.repeat(24);
  const quiet = {
    id: ORG, status: 'active' as const, inSetup: false, createdAt: ago(400 * DAY), locationCount: 1, lastUploadAt: ago(DAY),
    failedLocations: { count: 0, since: null }, invites: null, chatSpentMicroUsd: 0,
  };
  const facts = (over: Partial<AttentionFacts> = {}): AttentionFacts => ({
    now: NOW, pendingRequests: [], refreshRunning: true, paused: null, orgs: [quiet], chatBudgetMicroUsd: 20_000_000, ...over,
  });
  const kinds = (input: AttentionFacts): string[] => attentionOf(input).map((item) => item.kind);

  it('says nothing for a quiet organization on a running refresh', () => {
    expect(attentionOf(facts())).toEqual([]);
  });

  it('lists a request pending more than 2 days, with its id, and not one 2 days old', () => {
    const items = attentionOf(facts({
      pendingRequests: [{ id: 'r1', createdAt: ago(2 * DAY) }, { id: 'r2', createdAt: ago(2 * DAY + 1000) }],
    }));
    expect(items).toEqual([{ kind: 'request_waiting', orgId: null, requestId: 'r2', count: null, since: ago(2 * DAY + 1000).toISOString() }]);
  });

  it('lists the refresh off on this server, and paused by staff since its pause', () => {
    expect(attentionOf(facts({ refreshRunning: false }))).toEqual([{ kind: 'refresh_off', orgId: null, requestId: null, count: null, since: null }]);
    expect(attentionOf(facts({ paused: { at: ago(3 * DAY) } })))
      .toEqual([{ kind: 'refresh_paused', orgId: null, requestId: null, count: null, since: ago(3 * DAY).toISOString() }]);
  });

  it('lists an organization whose refresh failed, with how many locations', () => {
    expect(attentionOf(facts({ orgs: [{ ...quiet, failedLocations: { count: 2, since: ago(DAY) } }] })))
      .toEqual([{ kind: 'refresh_failed', orgId: ORG, requestId: null, count: 2, since: ago(DAY).toISOString() }]);
  });

  it('lists an active organization out of setup with a location and no applied upload in more than 14 days, or ever', () => {
    expect(kinds(facts({ orgs: [{ ...quiet, lastUploadAt: ago(14 * DAY) }] }))).toEqual([]);
    expect(attentionOf(facts({ orgs: [{ ...quiet, lastUploadAt: ago(14 * DAY + 1000) }] })))
      .toEqual([{ kind: 'no_recent_upload', orgId: ORG, requestId: null, count: null, since: ago(14 * DAY + 1000).toISOString() }]);
    expect(attentionOf(facts({ orgs: [{ ...quiet, lastUploadAt: null }] })))
      .toEqual([{ kind: 'no_recent_upload', orgId: ORG, requestId: null, count: null, since: null }]);
    // Not a suspended organization, one with no location, or one in setup (which has its own item).
    expect(kinds(facts({ orgs: [{ ...quiet, lastUploadAt: null, status: 'suspended' }] }))).toEqual([]);
    expect(kinds(facts({ orgs: [{ ...quiet, lastUploadAt: null, locationCount: 0 }] }))).toEqual([]);
    expect(kinds(facts({ orgs: [{ ...quiet, lastUploadAt: null, inSetup: true }] }))).toEqual(['in_setup']);
  });

  it('lists an organization in staff setup since it was created', () => {
    expect(attentionOf(facts({ orgs: [{ ...quiet, inSetup: true, createdAt: ago(5 * DAY) }] })))
      .toEqual([{ kind: 'in_setup', orgId: ORG, requestId: null, count: null, since: ago(5 * DAY).toISOString() }]);
  });

  it('lists invitations open more than 7 days with how many, from what the store found before that line', () => {
    expect(attentionOf(facts({ orgs: [{ ...quiet, invites: { count: 2, oldest: ago(9 * DAY) } }] })))
      .toEqual([{ kind: 'invites_waiting', orgId: ORG, requestId: null, count: 2, since: ago(9 * DAY).toISOString() }]);
  });

  it('lists an organization past 80% of the month’s TownwiseAI budget, and never while the budget is 0', () => {
    expect(kinds(facts({ orgs: [{ ...quiet, chatSpentMicroUsd: 16_000_000 }] }))).toEqual([]);
    expect(attentionOf(facts({ orgs: [{ ...quiet, chatSpentMicroUsd: 16_000_001 }] })))
      .toEqual([{ kind: 'chat_budget', orgId: ORG, requestId: null, count: null, since: null }]);
    expect(kinds(facts({ chatBudgetMicroUsd: 0, orgs: [{ ...quiet, chatSpentMicroUsd: 5 }] }))).toEqual([]);
  });

  it('orders by kind as the design lists them, then oldest first', () => {
    const other = 'e'.repeat(24);
    const items = attentionOf(facts({
      refreshRunning: false,
      paused: { at: ago(DAY) },
      pendingRequests: [{ id: 'newer', createdAt: ago(3 * DAY) }, { id: 'older', createdAt: ago(6 * DAY) }],
      orgs: [
        { ...quiet, lastUploadAt: ago(20 * DAY), invites: { count: 1, oldest: ago(8 * DAY) }, chatSpentMicroUsd: 19_000_000, failedLocations: { count: 1, since: ago(DAY) } },
        { ...quiet, id: other, lastUploadAt: null, inSetup: false, invites: { count: 3, oldest: ago(30 * DAY) } },
        { ...quiet, id: 'f'.repeat(24), inSetup: true, createdAt: ago(2 * DAY) },
      ],
    }));
    expect(items.map((item) => [item.kind, item.requestId ?? item.orgId])).toEqual([
      ['request_waiting', 'older'], ['request_waiting', 'newer'], ['refresh_off', null], ['refresh_paused', null], ['refresh_failed', ORG],
      ['no_recent_upload', other], ['no_recent_upload', ORG], ['in_setup', 'f'.repeat(24)], ['invites_waiting', other], ['invites_waiting', ORG],
      ['chat_budget', ORG],
    ]);
  });
});
