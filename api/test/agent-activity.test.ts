// D59 (openspec change auto-apply-agent-reads, design decision 11): TownwiseAI's changes in its activity and its log,
// over fake stores. Each change is an `agent_change` item with no title, why, file name or figure; one still being
// applied is left out; Undo is offered only on an applied change whose target is still as it was, to a caller the
// action's role allows, never under view-as; a `sales_days.add` change shows once, in place of its upload; and the
// log's view carries the why outside view-as only. Synthetic records.
import { describe, expect, it } from 'vitest';

import type { MemberPrincipal, OrgScope } from '../src/access/policy.ts';
import { activityFor, agentChangeSource, ACTIVITY_SOURCES, type ActivityInput } from '../src/agent/activity.ts';
import { changeView, mayUndo, targetStates, undoable, type Target, type TargetState } from '../src/agent/changes.ts';
import type { TownwiseContext } from '../src/app.ts';
import type { AgentChangeRecord } from '../src/stores/agent-changes.ts';

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
    startDate: '2026-06-14', endDate: '2026-06-14', noteKind: 'private_event', count: null, appliedAt: AT, statusAt: AT, statusBy: 'townwise_ai', ...over,
  };
}

type Caller = Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>;
const MEMBER: Caller = { role: 'member', userId: 'member', viewAs: null };
const ADMIN: Caller = { role: 'org_admin', userId: 'admin', viewAs: null };
const VIEW_AS: Caller = { role: 'org_admin', userId: 'admin', viewAs: { grantId: 'g', actor: { userId: 's', email: 's@example.test', sessionId: 'x', verifiedUntil: '' } } };

/** A context whose stores answer `changes` and their targets: notes by id (with their updatedAt), items and uploads. */
function contextWith(
  changes: readonly AgentChangeRecord[], targets: { notes?: Record<string, Date>; items?: string[]; uploads?: string[]; labels?: Record<string, number> } = {},
): TownwiseContext {
  return {
    stores: {
      agentChanges: { page: () => Promise.resolve({ changes: [...changes], next: null }) },
      notes: { byIds: (_scope: OrgScope, wanted: readonly string[]) => Promise.resolve(wanted.flatMap((id) => {
        const updatedAt = targets.notes?.[id];
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
        startDate: '2026-06-14', endDate: '2026-06-14', noteKind: 'private_event', count: null, undoable: true,
      },
      expect.objectContaining({ changeId: undone.id, status: 'undone', undoable: false }),
    ]);
    expect(JSON.stringify(items)).not.toContain(SENTINEL);
    expect(ACTIVITY_SOURCES.at(-1)).toBe(agentChangeSource);
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
      startDate: '2025-07-12', endDate: '2026-06-20', noteKind: null, count: 12, undoable: true,
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
      startDate: '2026-06-14', endDate: '2026-06-14', noteKind: 'private_event', count: null, why: SENTINEL, undoable: true, targetId: row.targetId,
    });
    expect(changeView(VIEW_AS, row, states)).toMatchObject({ why: null, undoable: false });
    expect(changeView(MEMBER, { ...row, status: 'applying' }, states)).toMatchObject({ targetId: null, undoable: false });
  });
});
