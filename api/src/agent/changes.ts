// TownwiseAI's changes as people see them (D59, openspec change auto-apply-agent-reads design decisions 10 and 11): who
// may undo which action, what each change's target is now (there, gone, or changed by a person since), and the log's
// view of a row. Shared by the activity (agent/activity.ts), the log and the undo (handlers/agent-changes.ts). Reads
// only; never a title, a file name or a figure, and the why only in the log, outside view-as.
import type { MemberPrincipal, OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import type { AgentChangeAction, AgentChangeRecord, AgentChangeStatus, AgentSourceKind } from '../stores/agent-changes.ts';
import type { NoteKind } from '../stores/notes.ts';

/** What a change's target is now. */
export type TargetState = 'there' | 'gone' | 'changed';

/**
 * Who may undo an action (design decision 6): any member a note or rule, the source file's adder or an org admin a summary
 * item, an org admin sales days or a label. Never under view-as.
 */
export function mayUndo(caller: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>, change: Pick<AgentChangeRecord, 'action' | 'onBehalfOf'>): boolean {
  if (caller.viewAs !== null) return false;
  switch (change.action) {
    case 'note.add':
    case 'rule.add':
      return true;
    case 'item.add':
      return caller.role === 'org_admin' || caller.userId === change.onBehalfOf;
    case 'sales_days.add':
    case 'booking.label':
      return caller.role === 'org_admin';
  }
}

/** Each applied change's target now, by the change's id: a note edited since it was applied reads `changed`. */
export async function targetStates(
  ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, locationId: string, changes: readonly AgentChangeRecord[],
): Promise<Map<string, TargetState>> {
  const applied = changes.filter((change) => change.status === 'applied');
  const ids = (action: AgentChangeAction): string[] => applied.filter((change) => change.action === action).map((change) => change.targetId);
  const [notes, items, uploads] = await Promise.all([
    ctx.stores.notes.byIds(scope, ids('note.add')),
    ctx.stores.files.byIds(scope, ids('item.add')),
    Promise.all(ids('sales_days.add').map((id) => ctx.stores.uploads.get(scope, locationId, id))),
  ]);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const itemIds = new Set(items.filter((file) => file.status !== 'deleting').map((file) => file.id));
  const uploadIds = new Set(uploads.flatMap((upload) => (upload === null ? [] : [upload.id])));
  return new Map(applied.map((change): [string, TargetState] => {
    if (change.action === 'note.add') {
      const note = noteById.get(change.targetId);
      if (note === undefined) return [change.id, 'gone'];
      return [change.id, note.updatedAt.getTime() === change.targetUpdatedAt?.getTime() ? 'there' : 'changed'];
    }
    if (change.action === 'item.add') return [change.id, itemIds.has(change.targetId) ? 'there' : 'gone'];
    if (change.action === 'sales_days.add') return [change.id, uploadIds.has(change.targetId) ? 'there' : 'gone'];
    return [change.id, 'there'];
  }));
}

/** Whether Undo is offered: applied, its target still there and unchanged, and the caller may undo it. */
export function undoable(
  caller: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>, change: AgentChangeRecord, states: ReadonlyMap<string, TargetState>,
): boolean {
  return change.status === 'applied' && states.get(change.id) === 'there' && mayUndo(caller, change);
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
  why: string | null;
  undoable: boolean;
  /** The note, item or upload it added (an id: a note's page opens by it), or null for a row never applied. */
  targetId: string | null;
}

export function changeView(
  caller: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>, change: AgentChangeRecord, states: ReadonlyMap<string, TargetState>,
): AgentChangeView {
  return {
    id: change.id, at: change.appliedAt.toISOString(), action: change.action, sourceKind: change.sourceKind,
    sourceRef: change.sourceKind === 'file' && change.sourceId !== null ? `f_${change.sourceId}` : null, status: change.status,
    startDate: change.startDate, endDate: change.endDate, noteKind: change.noteKind, why: caller.viewAs === null ? change.why : null,
    undoable: undoable(caller, change, states), targetId: change.status === 'applying' ? null : change.targetId,
  };
}
