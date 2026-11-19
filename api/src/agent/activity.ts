// TownwiseAI's "What it's been doing" (spec 10.12, docs/portal/tuning-chat.md section 8): real, dated events of the
// location only, read at request time, never an illustration. Each source reads one kind of record; the list merges
// them newest first. Items carry dates, counts and ids, never a file name, a note's detail or a figure.
//
// Sources now: applied sales uploads, notes the caller saved from their own TownwiseAI proposals, answers to
// TownwiseAI's questions (an answer that saved a note shows as that note: a closure note, or a likely-closed day's
// open-day note), and (F3) stored files Townwise read,
// as `file_processed { fileId, firstDate, lastDate, dayCount }`: the upload record a read file writes is then left out,
// so one read shows once. Never the file's name: names stay in the files list, and this panel is read under view-as
// too. A later source appends itself to ACTIVITY_SOURCES (forecasts add `forecast_made`). The client renders a kind it
// does not know as nothing.
//
// D59 (openspec change auto-apply-agent-reads, design decision 11): each change TownwiseAI saved on its own, as
// `agent_change { changeId, action, sourceKind, status, startDate, endDate, noteKind, undoable }`, dated when it was
// applied, with no title, why, file name or figure (the why is in the log). `undoable` is false under view-as, once a
// person changed the target, and for a caller the action's role refuses. The upload a `sales_days.add` change wrote is
// then left out, so the change shows once.
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope } from '../access/policy.ts';
import type { AgentChangeAction, AgentChangeStatus, AgentSourceKind } from '../stores/agent-changes.ts';
import type { NoteKind, NoteRecord } from '../stores/notes.ts';
import type { AnswerRecord } from '../stores/agent-answers.ts';
import { targetStates, undoable } from './changes.ts';
import { noteFor, parseQuestionId } from './questions.ts';

/** At most this many items. */
export const MAX_ACTIVITY = 20;
/** Uploads read per request, newest first. */
const UPLOADS_READ = 10;
/** F3: stored files read per request, newest first. */
const FILES_READ = 10;
/** D59: TownwiseAI's changes read per request, newest first. */
const CHANGES_READ = MAX_ACTIVITY;

export type ActivityItem =
  | { at: string; kind: 'upload_applied'; firstDate: string; lastDate: string; dayCount: number }
  | { at: string; kind: 'note_saved'; via: 'chat' | 'question'; noteId: string; noteKind: NoteKind; startDate: string; endDate: string }
  | { at: string; kind: 'question_answered'; questionId: string; answer: 'open' | 'not_sure' | 'other' }
  | { at: string; kind: 'file_processed'; fileId: string; firstDate: string; lastDate: string; dayCount: number }
  | {
    at: string; kind: 'agent_change'; changeId: string; action: AgentChangeAction; sourceKind: AgentSourceKind; status: AgentChangeStatus;
    startDate: string | null; endDate: string | null; noteKind: NoteKind | null; undoable: boolean;
  };

export interface ActivityInput {
  readonly ctx: TownwiseContext;
  readonly scope: OrgScope;
  readonly locationId: string;
  /** The caller: only their own conversations' proposals show. */
  readonly userId: string;
  /** D59: the caller, for whether Undo is offered on TownwiseAI's changes; none offered when left out. */
  readonly caller?: Pick<MemberPrincipal, 'role' | 'userId' | 'viewAs'>;
  /** The location's notes and answers, already read for the questions. */
  readonly notes: readonly NoteRecord[];
  readonly answers: readonly AnswerRecord[];
}

/**
 * An item as a source gives it. `uploadId` (F3) links an applied upload and the stored file whose read wrote it, so the
 * merge keeps the file's item only; it never leaves this module.
 */
export type SourceItem = ActivityItem & { readonly uploadId?: string };

export type ActivitySource = (input: ActivityInput) => Promise<SourceItem[]>;

function savedNote(note: NoteRecord, via: 'chat' | 'question'): ActivityItem {
  return {
    at: note.createdAt.toISOString(), kind: 'note_saved', via, noteId: note.id, noteKind: note.kind,
    startDate: note.startDate, endDate: note.endDate,
  };
}

const uploads: ActivitySource = async ({ ctx, scope, locationId }) => {
  const recent = await ctx.stores.uploads.recent(scope, locationId, UPLOADS_READ);
  return recent.filter((upload) => upload.status === 'applied').map((upload) => ({
    at: upload.uploadedAt.toISOString(), kind: 'upload_applied', firstDate: upload.firstDate, lastDate: upload.lastDate,
    dayCount: upload.dayCount, uploadId: upload.id,
  }));
};

/** A note deleted since is left out: there is nothing left to point at. */
const savedProposals: ActivitySource = async ({ ctx, scope, locationId, userId, notes }) => {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const noteIds = await ctx.stores.chatProposals.listSaved(scope, { locationId, userId }, MAX_ACTIVITY);
  return noteIds.flatMap((id) => {
    const note = byId.get(id);
    return note === undefined ? [] : [savedNote(note, 'chat')];
  });
};

const answers: ActivitySource = ({ notes, answers: rows }) => {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return Promise.resolve(rows.filter((row) => row.status === 'done').flatMap((row): ActivityItem[] => {
    const { answer } = row;
    const asked = parseQuestionId(row.questionId);
    // `closed` always saves a note; `open` saves one on a likely-closed question.
    if (answer !== 'closed' && (asked === null || noteFor(asked, answer) === null)) {
      return [{ at: row.updatedAt.toISOString(), kind: 'question_answered', questionId: row.questionId, answer }];
    }
    const note = byId.get(row.noteId);
    return note === undefined ? [] : [savedNote(note, 'question')];
  }));
};

/**
 * F3: stored files Townwise read (status `read`, with what they added), dated when the read ended. A file kept unread
 * or failed added nothing, and the files list says why.
 */
const files: ActivitySource = async ({ ctx, scope, locationId, userId }) => {
  const recent = await ctx.stores.files.list(scope, locationId, { viewerId: userId, before: null, limit: FILES_READ });
  return recent.flatMap((file): SourceItem[] => {
    const { result } = file;
    if (file.status !== 'read' || result === null) return [];
    const ended = file.readStartedAt === null ? file.uploadedAt : new Date(file.readStartedAt.getTime() + (file.readMs ?? 0));
    return [{
      at: ended.toISOString(), kind: 'file_processed', fileId: file.id, firstDate: result.firstDate, lastDate: result.lastDate,
      dayCount: result.dayCount, uploadId: result.uploadId,
    }];
  });
};

/**
 * D59: the changes TownwiseAI saved on its own, newest first, but those still being applied; a `sales_days.add` change
 * carries its upload's id, so the merge leaves that upload's own item out.
 */
const agentChanges: ActivitySource = async ({ ctx, scope, locationId, caller }) => {
  const { changes } = await ctx.stores.agentChanges.page(scope, locationId, { limit: CHANGES_READ });
  const shown = changes.filter((change) => change.status !== 'applying');
  const states = await targetStates(ctx, scope, locationId, shown);
  return shown.map((change): SourceItem => ({
    at: change.appliedAt.toISOString(), kind: 'agent_change', changeId: change.id, action: change.action, sourceKind: change.sourceKind,
    status: change.status, startDate: change.startDate, endDate: change.endDate, noteKind: change.noteKind,
    undoable: caller === undefined ? false : undoable(caller, change, states),
    ...(change.action === 'sales_days.add' ? { uploadId: change.targetId } : {}),
  }));
};

/** Append-only: each later source adds one entry. */
export const ACTIVITY_SOURCES: readonly ActivitySource[] = [uploads, savedProposals, answers, files, agentChanges];

/** The item as the route answers it: without the merge's upload link. */
function published(item: SourceItem): ActivityItem {
  const copy = { ...item };
  Reflect.deleteProperty(copy, 'uploadId');
  return copy;
}

/** Every source's items, newest first, at most MAX_ACTIVITY; an upload a listed file's read wrote shows as that file. */
export async function activityFor(input: ActivityInput, sources: readonly ActivitySource[] = ACTIVITY_SOURCES): Promise<ActivityItem[]> {
  const items = (await Promise.all(sources.map((source) => source(input)))).flat();
  const fromFiles = new Set(items.flatMap((item) => (
    (item.kind === 'file_processed' || item.kind === 'agent_change') && item.uploadId !== undefined ? [item.uploadId] : []
  )));
  return items
    .filter((item) => item.kind !== 'upload_applied' || item.uploadId === undefined || !fromFiles.has(item.uploadId))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_ACTIVITY).map(published);
}
