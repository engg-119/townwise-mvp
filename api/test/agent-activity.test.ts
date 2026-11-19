// D59 (openspec change auto-apply-agent-reads, design decision 11): TownwiseAI's changes in its activity and its log,
// over fake stores. Each change is an `agent_change` item with no title, why, file name or figure; one still being
// applied is left out; Undo is offered only on an applied change whose target is still as it was, to a caller the
// action's role allows, never under view-as; a `sales_days.add` change shows once, in place of its upload; and the
// log's view carries the why outside view-as only; (slice 3) a rule TownwiseAI added is undoable while unchanged.
// D65 (openspec change forecast-training-status, design decision 6): each finished forecast run as `forecast_made`, a
// live one past its 20 minutes as a failed run, with codes, dates and day counts only, the newest 5 kept through the cut.
// D66 (openspec change town-research-agent, design decision 15): research runs as `research_done`, the town's with its
// status and counts only, and none while research is off for the organization. Synthetic records.
import { describe, expect, it } from 'vitest';

import type { MemberPrincipal, OrgScope } from '../src/access/policy.ts';
import {
  activityFor, agentChangeSource, ACTIVITY_SOURCES, forecastMadeSource, MAX_ACTIVITY, researchSource, type ActivityInput, type ActivitySource,
} from '../src/agent/activity.ts';
import { changeView, mayUndo, targetStates, undoable, type Target, type TargetState } from '../src/agent/changes.ts';
import type { TownwiseContext } from '../src/app.ts';
import type { AgentChangeRecord } from '../src/stores/agent-changes.ts';
import type { CalibrationRecord } from '../src/stores/calibrations.ts';
import type { RunState } from '../src/stores/forecasts.ts';
import type { RunRecordBase, ThreadStatus } from '../src/stores/research-shared.ts';
import { calibrationRecord } from './helpers/calibration-record.ts';

const SCOPE = { orgId: 'a'.repeat(24) } as unknown as OrgScope;
const LOCATION = 'b'.repeat(24);
const AT = new Date('2026-06-01T10:00:00.000Z');
const SENTINEL = 'Sentinel-why-words';

let ids = 0;
function change(over: Partial<AgentChangeRecord> = {}): AgentChangeRecord {
  ids += 1;
  const n = String(ids).padStart(24, '0');
  return {
    id: n, locationId: LOCATION, sourceKind: 'file', sourceId: 'f'.repeat(24), action: 'note.add', targetId: `t${n.slice(1)}`,
    dedupeKey: `key-${n}`, confidence: 'high', why: SENTINEL, onBehalfOf: 'adder', status: 'applied', targetUpdatedAt: AT,
    startDate: '2026-06-14', endDate: '2026-06-14', noteKind: 'private_event', weekdays: null, count: null, appliedAt: AT, statusAt: AT,
    statusBy: 'townwise_ai', ...over,
  };
}

type Caller = Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>;
const MEMBER: Caller = { role: 'member', userId: 'member', viewAs: null };
const ADMIN: Caller = { role: 'org_admin', userId: 'admin', viewAs: null };
const VIEW_AS: Caller = { role: 'org_admin', userId: 'admin', viewAs: { grantId: 'g', actor: { userId: 's', email: 's@example.test', sessionId: 'x', verifiedUntil: '' } } };

/** A context whose stores answer `changes` and their targets: notes by id (with their updatedAt), items and uploads. */
function contextWith(
  changes: readonly AgentChangeRecord[],
  targets: { notes?: Record<string, Date>; items?: string[]; uploads?: string[]; labels?: Record<string, number>; rules?: Record<string, Date> } = {},
): TownwiseContext {
  return {
    stores: {
      agentChanges: { page: () => Promise.resolve({ changes: [...changes], next: null }) },
      notes: { byIds: (_scope: OrgScope, wanted: readonly string[]) => Promise.resolve(wanted.flatMap((id) => {
        const updatedAt = targets.notes?.[id];
        return updatedAt === undefined ? [] : [{ id, updatedAt, createdBy: 'townwise_ai' }];
      })) },
      businessRules: { byIds: (_scope: OrgScope, wanted: readonly string[]) => Promise.resolve(wanted.flatMap((id) => {
        const updatedAt = targets.rules?.[id];
        return updatedAt === undefined ? [] : [{ id, updatedAt, createdBy: 'townwise_ai' }];
      })) },
      files: { byIds: (_scope: OrgScope, wanted: readonly string[]) => Promise.resolve(wanted.filter((id) => targets.items?.includes(id)).map((id) => ({ id, status: 'kept' }))) },
      uploads: { get: (_scope: OrgScope, _location: string, id: string) => Promise.resolve(targets.uploads?.includes(id) === true ? { id } : null) },
      ownerCalendars: {
        aiLabelCount: (_scope: OrgScope, _location: string, id: string, at: Date) => Promise.resolve(at.getTime() === AT.getTime() ? targets.labels?.[id] ?? 0 : 0),
      },
    },
  } as unknown as TownwiseContext;
}

function input(ctx: TownwiseContext, caller?: Caller): ActivityInput {
  return { ctx, scope: SCOPE, locationId: LOCATION, userId: caller?.userId ?? 'member', notes: [], answers: [], ...(caller === undefined ? {} : { caller }) };
}

describe('TownwiseAI’s changes in its activity (D59)', () => {
  it('lists each change as agent_change, newest first, with dates and kinds only, and leaves one still being applied out', async () => {
    const note = change();
    const applying = change({ status: 'applying' });
    const undone = change({ status: 'undone', appliedAt: new Date('2026-06-01T09:00:00.000Z') });
    const ctx = contextWith([note, applying, undone], { notes: { [note.targetId]: AT } });
    const items = await activityFor(input(ctx, MEMBER), [agentChangeSource]);
    expect(items).toEqual([
      {
        at: AT.toISOString(), kind: 'agent_change', changeId: note.id, action: 'note.add', sourceKind: 'file', status: 'applied',
        startDate: '2026-06-14', endDate: '2026-06-14', noteKind: 'private_event', weekdays: null, count: null, undoable: true,
      },
      expect.objectContaining({ changeId: undone.id, status: 'undone', undoable: false }),
    ]);
    expect(JSON.stringify(items)).not.toContain(SENTINEL);
    expect(ACTIVITY_SOURCES).toContain(agentChangeSource);
  });

  it('offers no Undo once a person edited the note, once it is gone, under view-as, or with no caller', async () => {
    const edited = change();
    const gone = change();
    const kept = change();
    const ctx = contextWith([edited, gone, kept], { notes: { [edited.targetId]: new Date(AT.getTime() + 1), [kept.targetId]: AT } });
    const offered = async (caller?: Caller) => (await activityFor(input(ctx, caller), [agentChangeSource]))
      .map((item) => (item.kind === 'agent_change' ? item.undoable : null));
    expect(await offered(MEMBER)).toEqual([false, false, true]);
    expect(await offered(VIEW_AS)).toEqual([false, false, false]);
    expect(await offered()).toEqual([false, false, false]);
  });

  it('shows a sales_days.add change once, in place of the upload it wrote', async () => {
    const days = change({ action: 'sales_days.add', targetId: 'c'.repeat(24), noteKind: null, startDate: '2026-05-01', endDate: '2026-05-31' });
    const ctx = contextWith([days], { uploads: [days.targetId] });
    const upload = (): Promise<{ at: string; kind: 'upload_applied'; firstDate: string; lastDate: string; dayCount: number; uploadId: string }[]> => Promise.resolve([{
      at: '2026-06-01T10:00:00.000Z', kind: 'upload_applied', firstDate: '2026-05-01', lastDate: '2026-05-31', dayCount: 31, uploadId: days.targetId,
    }]);
    const items = await activityFor(input(ctx, ADMIN), [upload, agentChangeSource]);
    expect(items.map((item) => item.kind)).toEqual(['agent_change']);
    expect(items[0]).toMatchObject({ action: 'sales_days.add', undoable: true });
    // A member may not undo days.
    expect((await activityFor(input(ctx, MEMBER), [agentChangeSource]))[0]).toMatchObject({ undoable: false });
  });
});

describe('a rule TownwiseAI added (D59 slice 3)', () => {
  it('is undoable by any member while unchanged, not once a person edited it or it is gone', async () => {
    const rule = (over: Partial<AgentChangeRecord> = {}) => change({ action: 'rule.add', sourceKind: 'sales', noteKind: 'closure', endDate: null, ...over });
    const kept = rule({ weekdays: [1] });
    const edited = rule();
    const gone = rule();
    const ctx = contextWith([kept, edited, gone], { rules: { [kept.targetId]: AT, [edited.targetId]: new Date(AT.getTime() + 1) } });
    const items = await activityFor(input(ctx, MEMBER), [agentChangeSource]);
    expect(items.map((item) => (item.kind === 'agent_change' ? [item.action, item.sourceKind, item.undoable] : null))).toEqual([
      ['rule.add', 'sales', true], ['rule.add', 'sales', false], ['rule.add', 'sales', false],
    ]);
    // Its weekdays, so "Closed on Mondays" does not read as every day.
    expect(items[0]).toMatchObject({ weekdays: [1], endDate: null });
    expect(JSON.stringify(items)).not.toContain(SENTINEL);
  });
});

describe('who may undo, and the log’s view (D59)', () => {
  it('any member a note TownwiseAI wrote as itself; the file’s adder or an org admin an item; an org admin days; nobody under view-as', () => {
    expect(mayUndo(MEMBER, change(), 'townwise_ai')).toBe(true);
    expect(mayUndo(MEMBER, change({ action: 'item.add' }), null)).toBe(false);
    expect(mayUndo({ ...MEMBER, userId: 'adder' }, change({ action: 'item.add' }), null)).toBe(true);
    expect(mayUndo(ADMIN, change({ action: 'item.add' }), null)).toBe(true);
    expect(mayUndo(MEMBER, change({ action: 'sales_days.add' }), null)).toBe(false);
    expect(mayUndo(ADMIN, change({ action: 'sales_days.add' }), null)).toBe(true);
    expect(mayUndo(VIEW_AS, change(), 'townwise_ai')).toBe(false);
  });

  it('a note a pressed read wrote in a person’s name: only that person or an org admin, as deleting the note', () => {
    const pressed = change({ onBehalfOf: 'alice' });
    expect(mayUndo({ ...MEMBER, userId: 'bob' }, pressed, 'alice')).toBe(false);
    expect(mayUndo({ ...MEMBER, userId: 'alice' }, pressed, 'alice')).toBe(true);
    expect(mayUndo(ADMIN, pressed, 'alice')).toBe(true);
  });

  it('Undo is offered only on an applied change whose target is there, unchanged', () => {
    const row = change();
    const states = (state: TargetState): Map<string, Target> => new Map([[row.id, { state, author: 'townwise_ai' }]]);
    expect(undoable(MEMBER, row, states('there'))).toBe(true);
    expect(undoable(MEMBER, row, states('changed'))).toBe(false);
    expect(undoable(MEMBER, row, states('gone'))).toBe(false);
    expect(undoable(MEMBER, { ...row, status: 'adopted' }, states('there'))).toBe(false);
  });

  it('slice 2: a calendar’s labels are one line with their count, undone by an org admin only while any label of that sort is left', async () => {
    const calendarId = 'c'.repeat(24);
    const labels = change({
      action: 'booking.label', sourceKind: 'calendar', sourceId: calendarId, targetId: calendarId, why: null, noteKind: null, count: 12,
      startDate: '2025-07-12', endDate: '2026-06-20',
    });
    expect(mayUndo(MEMBER, labels, null)).toBe(false);
    expect(mayUndo(ADMIN, labels, null)).toBe(true);
    const there = await activityFor(input(contextWith([labels], { labels: { [calendarId]: 3 } }), ADMIN), [agentChangeSource]);
    expect(there).toEqual([{
      at: AT.toISOString(), kind: 'agent_change', changeId: labels.id, action: 'booking.label', sourceKind: 'calendar', status: 'applied',
      startDate: '2025-07-12', endDate: '2026-06-20', noteKind: null, weekdays: null, count: 12, undoable: true,
    }]);
    expect(await activityFor(input(contextWith([labels], { labels: { [calendarId]: 3 } }), MEMBER), [agentChangeSource]))
      .toEqual([expect.objectContaining({ undoable: false })]);
    // A person changed every label since (or the calendar went): nothing of the sort is left to undo.
    expect(await activityFor(input(contextWith([labels], { labels: {} }), ADMIN), [agentChangeSource]))
      .toEqual([expect.objectContaining({ undoable: false })]);
    const view = changeView(ADMIN, labels, await targetStates(contextWith([labels], { labels: { [calendarId]: 1 } }), SCOPE, LOCATION, [labels]));
    expect(view).toMatchObject({ action: 'booking.label', sourceRef: null, count: 12, undoable: true, targetId: calendarId });
  });

  it('the log carries the why outside view-as only, and points at the file and the target', () => {
    const row = change();
    const states = new Map<string, Target>([[row.id, { state: 'there', author: 'townwise_ai' }]]);
    expect(changeView(MEMBER, row, states)).toEqual({
      id: row.id, at: AT.toISOString(), action: 'note.add', sourceKind: 'file', sourceRef: `f_${'f'.repeat(24)}`, status: 'applied',
      startDate: '2026-06-14', endDate: '2026-06-14', noteKind: 'private_event', weekdays: null, count: null, why: SENTINEL, undoable: true,
      targetId: row.targetId,
    });
    expect(changeView(VIEW_AS, row, states)).toMatchObject({ why: null, undoable: false });
    expect(changeView(MEMBER, { ...row, status: 'applying' }, states)).toMatchObject({ targetId: null, undoable: false });
  });
});

describe('finished forecast runs in its activity (D65)', () => {
  const NOW = new Date('2026-11-23T09:00:00.000Z');
  const MINUTE = 60_000;

  /** A context whose stores answer these calibrations (newest first, as the store reads them), their runs and the first published run. */
  function runsContext(
    records: readonly CalibrationRecord[],
    { runs = {}, first = null, changes = [], current = [] }: {
      runs?: Record<string, RunState>; first?: { runId: string; publishedAt: Date } | null; changes?: readonly AgentChangeRecord[];
      current?: readonly { id: string }[];
    } = {},
  ): { ctx: TownwiseContext; reads: { runIds: string[][]; firsts: number } } {
    const reads = { runIds: [] as string[][], firsts: 0 };
    const base = contextWith(changes);
    const ctx = {
      ...base,
      now: () => NOW,
      stores: {
        ...base.stores,
        calibrations: { list: (_scope: OrgScope, limit: number) => Promise.resolve(records.slice(0, limit)) },
        forecasts: {
          runStates: (_scope: OrgScope, runIds: readonly string[]) => {
            reads.runIds.push([...runIds]);
            return Promise.resolve(new Map(runIds.flatMap((id) => (runs[id] === undefined ? [] : [[id, runs[id]] as const]))));
          },
          firstPublished: () => {
            reads.firsts += 1;
            return Promise.resolve(first);
          },
          published: () => Promise.resolve(current),
        },
      },
    } as unknown as TownwiseContext;
    return { ctx, reads };
  }

  const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * MINUTE);
  const draft: RunState = { status: 'draft', publishedAt: null, publishedBy: null };

  it('lists a run the gate kept with its causes and days, and nothing else; the source is the last one', async () => {
    const kept = calibrationRecord({
      id: 'k1', requestedBy: { userId: null, role: 'system', via: 'scheduled' }, causes: ['sales'], runId: 'r1',
      gate: { published: false, reason: 'not_better' }, dayCount: 1041, dataFrom: '2024-01-01', dataThrough: '2026-11-21', newDays: 6,
      scorecardJson: '{"mae":12.5}', requestedAt: minutesAgo(50), finishedAt: minutesAgo(44),
    });
    const { ctx } = runsContext([kept], {
      runs: { r1: draft }, first: { runId: 'r0', publishedAt: new Date('2026-01-05T10:00:00.000Z') }, current: [{ id: 'r0' }],
    });
    const items = await activityFor(input(ctx, ADMIN), [forecastMadeSource]);
    expect(items).toEqual([{
      at: minutesAgo(44).toISOString(), kind: 'forecast_made', calibrationId: 'k1', causes: ['sales'], outcome: 'kept',
      reason: 'not_more_accurate', firstForecast: false, currentForecast: true, dayCount: 1041, firstDate: '2024-01-01', lastDate: '2026-11-21', newDays: 6,
    }]);
    // No accuracy and no figure of the scorecard.
    expect(JSON.stringify(items)).not.toContain('12.5');
    expect(ACTIVITY_SOURCES.at(-2)).toBe(forecastMadeSource);
  });

  it('merges with uploads by when each finished, reading the runs once and the first run once', async () => {
    const older = calibrationRecord({ id: 'o1', status: 'failed', failure: 'timeout', requestedAt: minutesAgo(300), finishedAt: minutesAgo(280) });
    const newer = calibrationRecord({
      id: 'n1', runId: 'r2', gate: { published: true, reason: 'published' }, requestedAt: minutesAgo(30), finishedAt: minutesAgo(24),
    });
    const { ctx, reads } = runsContext([newer, older], {
      runs: { r2: { status: 'published', publishedAt: minutesAgo(24), publishedBy: null } }, first: { runId: 'r2', publishedAt: minutesAgo(24) },
    });
    const upload: ActivitySource = () => Promise.resolve([{
      at: minutesAgo(100).toISOString(), kind: 'upload_applied', firstDate: '2026-11-01', lastDate: '2026-11-21', dayCount: 21,
    }]);
    const items = await activityFor(input(ctx, ADMIN), [upload, forecastMadeSource]);
    expect(items.map((item) => [item.kind, item.kind === 'forecast_made' ? [item.calibrationId, item.outcome, item.reason, item.firstForecast] : null]))
      .toEqual([
        ['forecast_made', ['n1', 'published', 'published', true]],
        ['upload_applied', null],
        ['forecast_made', ['o1', 'not_run', 'failed', true]],
      ]);
    expect(reads).toEqual({ runIds: [['r2']], firsts: 1 });
  });

  it('leaves a live run under its 20 minutes out, and lists one past them as failed at its request plus 20 minutes, read only', async () => {
    const running = calibrationRecord({ id: 'l1', status: 'running', finishedAt: null, requestedAt: minutesAgo(19) });
    const stale = calibrationRecord({ id: 'l0', status: 'queued', finishedAt: null, requestedAt: minutesAgo(21) });
    const { ctx } = runsContext([running, stale]);
    expect(await activityFor(input(ctx, ADMIN), [forecastMadeSource])).toEqual([expect.objectContaining({
      at: minutesAgo(1).toISOString(), calibrationId: 'l0', outcome: 'not_run', reason: 'failed', firstForecast: true,
    })]);
    // Only live ones under 20 minutes: nothing is read beyond the calibrations.
    const { ctx: quiet, reads } = runsContext([running]);
    expect(await activityFor(input(quiet, ADMIN), [forecastMadeSource])).toEqual([]);
    expect(reads).toEqual({ runIds: [], firsts: 0 });
  });

  it('keeps the newest 5 runs through the cut when 20 TownwiseAI changes are newer', async () => {
    const changes = Array.from({ length: MAX_ACTIVITY }, (_, i) => change({ appliedAt: minutesAgo(10 + i) }));
    const runs = Array.from({ length: 7 }, (_, i) => calibrationRecord({
      id: `run${String(i)}`, status: 'failed', failure: 'job_failed', requestedAt: minutesAgo(200 + i * 60), finishedAt: minutesAgo(190 + i * 60),
    }));
    const { ctx } = runsContext(runs, { changes });
    const items = await activityFor(input(ctx, ADMIN), [agentChangeSource, forecastMadeSource]);
    expect(items).toHaveLength(MAX_ACTIVITY);
    expect(items.flatMap((item) => (item.kind === 'forecast_made' ? [item.calibrationId] : [])))
      .toEqual(['run0', 'run1', 'run2', 'run3', 'run4']);
    // The newest 15 changes fill the rest, newest first, and the runs come after them.
    expect(items.slice(0, 15).every((item) => item.kind === 'agent_change')).toBe(true);
    // With room to spare, older runs past the 5 are listed too.
    const { ctx: roomy } = runsContext(runs);
    expect(await activityFor(input(roomy, ADMIN), [forecastMadeSource])).toHaveLength(7);
  });

  it('a run is the first forecast only when no other run was published at or before it finished', async () => {
    const finished = minutesAgo(44);
    const record = calibrationRecord({ id: 'f1', runId: 'r5', gate: { published: false, reason: 'baseline_not_beaten' }, finishedAt: finished });
    const first = async (published: { runId: string; publishedAt: Date } | null): Promise<unknown> => {
      const { ctx } = runsContext([record], { runs: { r5: draft }, first: published });
      const [item] = await activityFor(input(ctx, ADMIN), [forecastMadeSource]);
      return item?.kind === 'forecast_made' ? [item.reason, item.firstForecast] : null;
    };
    expect(await first(null)).toEqual(['not_beat_average', true]);
    // A run published (and since lapsed or withdrawn) before: not a first forecast.
    expect(await first({ runId: 'r0', publishedAt: new Date('2026-03-01T10:00:00.000Z') })).toEqual(['not_beat_average', false]);
    expect(await first({ runId: 'r0', publishedAt: finished })).toEqual(['not_beat_average', false]);
    // Another run published after it finished, or its own run: still the first.
    expect(await first({ runId: 'r0', publishedAt: new Date(finished.getTime() + 1) })).toEqual(['not_beat_average', true]);
    expect(await first({ runId: 'r5', publishedAt: new Date(finished.getTime() + MINUTE) })).toEqual(['not_beat_average', true]);
  });

  it('says on every item whether the location has a published run now: none once every run was withdrawn', async () => {
    const failed = calibrationRecord({ id: 'w1', status: 'failed', failure: 'job_failed', requestedAt: minutesAgo(30), finishedAt: minutesAgo(24) });
    const withdrawnFirst = { runId: 'r0', publishedAt: new Date('2026-11-01T10:00:00.000Z') };
    const { ctx } = runsContext([failed], { first: withdrawnFirst });
    expect(await activityFor(input(ctx, ADMIN), [forecastMadeSource])).toEqual([expect.objectContaining({
      calibrationId: 'w1', reason: 'failed', firstForecast: false, currentForecast: false,
    })]);
    const { ctx: current } = runsContext([failed], { first: withdrawnFirst, current: [{ id: 'r9' }] });
    expect(await activityFor(input(current, ADMIN), [forecastMadeSource])).toEqual([expect.objectContaining({
      calibrationId: 'w1', firstForecast: false, currentForecast: true,
    })]);
  });

  it('answers the same items under view-as as to the owner, and with no caller, with codes, dates and counts only', async () => {
    const staffRun = calibrationRecord({
      id: 's1', requestedBy: { userId: 'staff-1', role: 'superadmin', via: 'chat' }, runId: 'r6', gate: { published: false, reason: 'jump_held' },
      dayCount: 400, dataFrom: '2025-10-01', newDays: null,
    });
    const { ctx } = runsContext([staffRun], { runs: { r6: { status: 'published', publishedAt: NOW, publishedBy: 'staff-1' } } });
    const owner = await activityFor(input(ctx, ADMIN), [forecastMadeSource]);
    expect(await activityFor(input(ctx, VIEW_AS), [forecastMadeSource])).toEqual(owner);
    expect(await activityFor(input(ctx), [forecastMadeSource])).toEqual(owner);
    expect(owner).toEqual([{
      at: '2026-11-23T08:16:00.000Z', kind: 'forecast_made', calibrationId: 's1', causes: ['staff'], outcome: 'published',
      reason: 'published_by_staff', firstForecast: true, currentForecast: false, dayCount: 400, firstDate: '2025-10-01', lastDate: '2026-11-15', newDays: null,
    }]);
    expect(JSON.stringify(owner)).not.toContain('staff-1');
  });
});

describe('research runs in TownwiseAI’s activity (D66)', () => {
  const at = (hour: number) => new Date(`2026-06-0${String(hour)}T12:00:00.000Z`);
  let runIds = 0;
  function run(over: Partial<RunRecordBase> = {}): RunRecordBase & { trigger: 'press' } {
    runIds += 1;
    return {
      id: String(runIds).padStart(24, 'r'), key: `k${String(runIds)}`, status: 'done', code: null, threads: ['neighborhood', 'competitors'],
      counts: { found: 9, added: 3, updated: 2, dropped: 1 }, costMicroUsd: 5_000, createdAt: at(1), startedAt: at(1), finishedAt: at(1),
      trigger: 'press', ...over,
    };
  }

  interface Fakes {
    on?: boolean; research?: boolean; townId?: string | null;
    own?: RunRecordBase[]; town?: RunRecordBase[];
    events?: { origin: string; firstRunId: string; title: string }[];
    threads?: Record<string, ThreadStatus[]>;
  }
  function researchContext(fakes: Fakes, reads: string[] = []): TownwiseContext {
    const threadsOf = (id: string) => {
      reads.push(`threads:${id}`);
      return Promise.resolve((fakes.threads?.[id] ?? []).map((status) => ({ status })));
    };
    return {
      config: { research: fakes.research ?? true },
      logger: { warn: () => undefined },
      stores: {
        orgs: { findById: () => Promise.resolve({ research: { on: fakes.on ?? true } }) },
        locations: { find: () => Promise.resolve({ id: LOCATION, town: { townId: fakes.townId === undefined ? 'hanover-nh' : fakes.townId } }) },
        researchLocations: {
          reportedRuns: () => { reads.push('own'); return Promise.resolve(fakes.own ?? []); },
          competitorsAdded: (_scope: OrgScope, _locationId: string, runIds: readonly string[]) => {
            reads.push('competitors');
            const counts = new Map<string, number>();
            for (const row of fakes.events ?? []) {
              if (row.origin === 'competitor' && runIds.includes(row.firstRunId)) counts.set(row.firstRunId, (counts.get(row.firstRunId) ?? 0) + 1);
            }
            return Promise.resolve(counts);
          },
          threadsOf: (_scope: OrgScope, id: string) => threadsOf(id),
        },
        researchTowns: {
          reportedRuns: (townKey: string) => { reads.push(`town:${townKey}`); return Promise.resolve(fakes.town ?? []); },
          threadsOf,
        },
      },
    } as unknown as TownwiseContext;
  }

  it('lists the location’s and the town’s ended runs, newest first, with counts, failed topics and competitors’ new events', async () => {
    const press = run({ finishedAt: at(5) });
    const partial = run({ status: 'partial', finishedAt: at(3), counts: { found: 4, added: 1, updated: 0, dropped: 0 } });
    const townDone = run({ finishedAt: at(4), threads: ['schools', 'sports', 'civic'] });
    const townBudget = run({ status: 'budget', finishedAt: at(2), threads: ['schools', 'sports', 'civic'], counts: { found: 0, added: 0, updated: 0, dropped: 0 } });
    const reads: string[] = [];
    const ctx = researchContext({
      own: [press, partial], town: [townDone, townBudget],
      events: [
        { origin: 'competitor', firstRunId: press.id, title: 'Sentinel Trivia' }, { origin: 'competitor', firstRunId: press.id, title: 'Sentinel Jazz' },
        { origin: 'neighborhood', firstRunId: press.id, title: 'Sentinel Fair' }, { origin: 'competitor', firstRunId: 'gone-run', title: 'Sentinel Old' },
      ],
      threads: { [partial.id]: ['recorded', 'failed'] },
    }, reads);
    const items = await activityFor(input(ctx, MEMBER), [researchSource]);
    expect(items).toEqual([
      {
        at: at(5).toISOString(), kind: 'research_done', subject: 'location', status: 'done', found: 9, added: 3, competitors: 2, threadsFailed: 0,
        finishedAt: at(5).toISOString(),
      },
      // A town run is shared: its status and counts only, never what started it or when, and no competitors.
      {
        at: at(4).toISOString(), kind: 'research_done', subject: 'town', status: 'done', found: 9, added: 3, competitors: null, threadsFailed: 0,
        finishedAt: at(4).toISOString(),
      },
      {
        at: at(3).toISOString(), kind: 'research_done', subject: 'location', status: 'partial', found: 4, added: 1, competitors: 0, threadsFailed: 1,
        finishedAt: at(3).toISOString(),
      },
      {
        at: at(2).toISOString(), kind: 'research_done', subject: 'town', status: 'budget', found: 0, added: 0, competitors: null, threadsFailed: 3,
        finishedAt: at(2).toISOString(),
      },
    ]);
    // Only the partial run's threads are read; the town is the location's own.
    expect(reads.filter((read) => read.startsWith('threads:'))).toEqual([`threads:${partial.id}`]);
    expect(reads).toContain('town:hanover-nh');
    expect(JSON.stringify(items)).not.toContain('Sentinel');
    expect(JSON.stringify(items)).not.toContain('press');
    expect(ACTIVITY_SOURCES.at(-1)).toBe(researchSource);
  });

  it('shows nothing while TOWNWISE_RESEARCH or the organization’s switch is off, and reads no run', async () => {
    for (const fakes of [{ on: false }, { research: false }]) {
      const reads: string[] = [];
      const ctx = researchContext({ ...fakes, own: [run()], town: [run()] }, reads);
      expect(await activityFor(input(ctx, MEMBER), [researchSource])).toEqual([]);
      expect(reads).toEqual([]);
    }
  });

  it('reads no town run for a town outside the twelve', async () => {
    const reads: string[] = [];
    const ctx = researchContext({ townId: null, own: [] }, reads);
    expect(await activityFor(input(ctx, MEMBER), [researchSource])).toEqual([]);
    expect(reads.filter((read) => read.startsWith('town:'))).toEqual([]);
  });

  it('a failed run counts every topic as not finished', async () => {
    const failed = run({ status: 'failed', counts: { found: 0, added: 0, updated: 0, dropped: 0 } });
    const items = await activityFor(input(researchContext({ own: [failed] }), MEMBER), [researchSource]);
    expect(items).toEqual([expect.objectContaining({ subject: 'location', status: 'failed', threadsFailed: 2, competitors: 0 })]);
  });
});
