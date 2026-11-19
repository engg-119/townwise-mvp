// TownwiseAI's changes as people see them (D59, openspec change auto-apply-agent-reads design decisions 10 and 11): who
// may undo which action, what each change's target is now (there, gone, or changed by a person since), and the log's
// view of a row (slice 2: a calendar sort's labels are there while any of them is still TownwiseAI's; D66, a
// correction of a researched event is there while no revision but its own revert follows it). Shared by the activity (agent/activity.ts), the log and the undo (handlers/agent-changes.ts). Reads
// only; never a title, a file name or a figure, and the why only in the log, outside view-as.
import type { MemberPrincipal, OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import type { AgentChangeAction, AgentChangeRecord, AgentChangeStatus, AgentSourceKind } from '../stores/agent-changes.ts';
import type { NoteKind } from '../stores/notes.ts';
import { TOWNWISE_AI_AUTHOR } from './apply.ts';

/** What a change's target is now. */
export type TargetState = 'there' | 'gone' | 'changed';

/** A change's target now: its state, and for a note its author (`createdBy`), else null. */
export interface Target {
  readonly state: TargetState;
  readonly author: string | null;
}

/**
 * Who may undo an action (design decision 6), as deleting it would be allowed: any member a note TownwiseAI wrote as
 * itself (an automatic read) or a rule; a note a pressed read wrote in the name of the person who asked, only that person
 * or an org admin (as the note's own delete); the source file's adder or an org admin a summary item; an org admin
 * sales days or a label; (D66) any member a correction of a researched event, as any member may edit one (design
 * decision 11). `author` is the note's `createdBy`, null when the note is not there (an undo then removes nothing of
 * anyone's, so any member may finish it). Never under view-as.
 */
export function mayUndo(
  caller: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>, change: Pick<AgentChangeRecord, 'action' | 'onBehalfOf'>, author: string | null,
): boolean {
  if (caller.viewAs !== null) return false;
  switch (change.action) {
    case 'note.add':
      return author === null || author === TOWNWISE_AI_AUTHOR || caller.role === 'org_admin' || author === caller.userId;
    case 'rule.add':
    case 'event.correct':
      return true;
    case 'item.add':
      return caller.role === 'org_admin' || caller.userId === change.onBehalfOf;
    case 'sales_days.add':
    case 'booking.label':
      return caller.role === 'org_admin';
  }
}

/**
 * Each applied change's target now, by the change's id: a note edited since it was applied reads `changed`; (D66) a
 * correction reads `gone` once its revision went (a place or town change's cleanup), and `changed` once a revision
 * other than its own revert is based on it (a member's edit, hide or restore since).
 */
export async function targetStates(
  ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, locationId: string, changes: readonly AgentChangeRecord[],
): Promise<Map<string, Target>> {
  const applied = changes.filter((change) => change.status === 'applied');
  const ids = (action: AgentChangeAction): string[] => applied.filter((change) => change.action === action).map((change) => change.targetId);
  const corrections = ids('event.correct');
  const [notes, items, uploads, rules, revisions] = await Promise.all([
    ctx.stores.notes.byIds(scope, ids('note.add')),
    ctx.stores.files.byIds(scope, ids('item.add')),
    Promise.all(ids('sales_days.add').map((id) => ctx.stores.uploads.get(scope, locationId, id))),
    ctx.stores.businessRules.byIds(scope, ids('rule.add')),
    // A location holds at most 1,000 revisions (D66 design decision 11), read only when a correction is on the page.
    corrections.length === 0 ? Promise.resolve([]) : ctx.stores.researchRevisions.list(scope, locationId),
  ]);
  // Slice 2: a calendar's labels are there while any label of that sort is still TownwiseAI's, unchanged.
  const labelRows = applied.filter((change) => change.action === 'booking.label');
  const labelCounts = await Promise.all(labelRows.map((change) => ctx.stores.ownerCalendars.aiLabelCount(
    scope, locationId, change.targetId, change.targetUpdatedAt ?? change.appliedAt,
  )));
  const labelsThere = new Set(labelRows.filter((_, index) => (labelCounts[index] ?? 0) > 0).map((change) => change.id));
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const itemIds = new Set(items.filter((file) => file.status !== 'deleting').map((file) => file.id));
  const uploadIds = new Set(uploads.flatMap((upload) => (upload === null ? [] : [upload.id])));
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  // Each revision's child (the unique index allows one child of each), by the id it is based on.
  const childOf = new Map(revisions.map((revision) => [`${revision.eventId} ${revision.basedOn}`, revision]));
  const target = (state: TargetState, author: string | null = null): Target => ({ state, author });
  return new Map(applied.map((change): [string, Target] => {
    if (change.action === 'note.add') {
      const note = noteById.get(change.targetId);
      if (note === undefined) return [change.id, target('gone')];
      return [change.id, target(note.updatedAt.getTime() === change.targetUpdatedAt?.getTime() ? 'there' : 'changed', note.createdBy)];
    }
    if (change.action === 'item.add') return [change.id, target(itemIds.has(change.targetId) ? 'there' : 'gone')];
    if (change.action === 'sales_days.add') return [change.id, target(uploadIds.has(change.targetId) ? 'there' : 'gone')];
    if (change.action === 'booking.label') return [change.id, target(labelsThere.has(change.id) ? 'there' : 'gone')];
    if (change.action === 'event.correct') {
      const revision = revisionById.get(change.targetId);
      if (revision === undefined) return [change.id, target('gone')];
      const child = childOf.get(`${revision.eventId} ${revision.id}`);
      const ownRevert = child?.op === 'revert' && child.reverts === revision.id;
      return [change.id, target(child === undefined || ownRevert ? 'there' : 'changed')];
    }
    // Slice 3: a rule, as a note: changed once a person edited it since it was applied.
    const rule = ruleById.get(change.targetId);
    if (rule === undefined) return [change.id, target('gone')];
    return [change.id, target(rule.updatedAt.getTime() === change.targetUpdatedAt?.getTime() ? 'there' : 'changed', rule.createdBy)];
  }));
}

/** Whether Undo is offered: applied, its target still there and unchanged, and the caller may undo it. */
export function undoable(
  caller: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>, change: AgentChangeRecord, states: ReadonlyMap<string, Target>,
): boolean {
  const now = states.get(change.id);
  return change.status === 'applied' && now?.state === 'there' && mayUndo(caller, change, now.author);
}

/** A change as the log lists it. `why` is null under view-as. `noteId`, `fileId` and `uploadId` point at the target. */
export interface AgentChangeView {
  id: string;
  at: string;
  action: AgentChangeAction;
  sourceKind: AgentSourceKind;
  /** The file it came from, by its Your data ref (`f_<id>`), or null. */
  sourceRef: string | null;
  status: AgentChangeStatus;
  startDate: string | null;
  endDate: string | null;
  noteKind: NoteKind | null;
  /** Slice 3: the weekdays a note or rule covers (0 is Sunday), or null for every day. */
  weekdays: readonly number[] | null;
  /** How many records it added (a calendar sort's labels); null otherwise. */
  count: number | null;
  why: string | null;
  undoable: boolean;
  /**
   * The note, item or upload it added (an id: a note's page opens by it), or (D66) the revision a correction appended;
   * null for a row never applied.
   */
  targetId: string | null;
}

export function changeView(
  caller: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>, change: AgentChangeRecord, states: ReadonlyMap<string, Target>,
): AgentChangeView {
  return {
    id: change.id, at: change.appliedAt.toISOString(), action: change.action, sourceKind: change.sourceKind,
    sourceRef: change.sourceKind === 'file' && change.sourceId !== null ? `f_${change.sourceId}` : null, status: change.status,
    startDate: change.startDate, endDate: change.endDate, noteKind: change.noteKind, weekdays: change.weekdays, count: change.count,
    why: caller.viewAs === null ? change.why : null,
    undoable: undoable(caller, change, states), targetId: change.status === 'applying' ? null : change.targetId,
  };
}
