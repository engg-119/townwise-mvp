// TownwiseAI's "What it's been doing" (spec 10.12, docs/portal/tuning-chat.md section 8): real, dated events of the
// location only, read at request time, never an illustration. Each source reads one kind of record; the list merges
// them newest first. Items carry dates, counts and ids, never a file name, a note's detail or a figure.
//
// Sources now: applied sales uploads, notes the caller saved from their own TownwiseAI proposals, and answers to
// TownwiseAI's questions (a `closed` answer shows as the closure note it saved). A later source appends itself to
// ACTIVITY_SOURCES: stored files add `file_processed { fileId, firstDate, lastDate, dayCount }` (follow-up F3) and
// forecasts add `forecast_made`. The client renders a kind it does not know as nothing.
import type { TownwiseContext } from '../app.ts';
import type { OrgScope } from '../access/policy.ts';
import type { NoteKind, NoteRecord } from '../stores/notes.ts';
import type { AnswerRecord } from '../stores/agent-answers.ts';

/** At most this many items. */
export const MAX_ACTIVITY = 20;
/** Uploads read per request, newest first. */
const UPLOADS_READ = 10;

export type ActivityItem =
  | { at: string; kind: 'upload_applied'; firstDate: string; lastDate: string; dayCount: number }
  | { at: string; kind: 'note_saved'; via: 'chat' | 'question'; noteId: string; noteKind: NoteKind; startDate: string; endDate: string }
  | { at: string; kind: 'question_answered'; questionId: string; answer: 'open' | 'not_sure' };

export interface ActivityInput {
  readonly ctx: TownwiseContext;
  readonly scope: OrgScope;
  readonly locationId: string;
  /** The caller: only their own conversations' proposals show. */
  readonly userId: string;
  /** The location's notes and answers, already read for the questions. */
  readonly notes: readonly NoteRecord[];
  readonly answers: readonly AnswerRecord[];
}

export type ActivitySource = (input: ActivityInput) => Promise<ActivityItem[]>;

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
    dayCount: upload.dayCount,
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
    if (row.answer !== 'closed') {
      return [{ at: row.updatedAt.toISOString(), kind: 'question_answered', questionId: row.questionId, answer: row.answer }];
    }
    const note = byId.get(row.noteId);
    return note === undefined ? [] : [savedNote(note, 'question')];
  }));
};

/** Append-only: each later source adds one entry. */
export const ACTIVITY_SOURCES: readonly ActivitySource[] = [uploads, savedProposals, answers];

/** Every source's items, newest first, at most MAX_ACTIVITY. */
export async function activityFor(input: ActivityInput, sources: readonly ActivitySource[] = ACTIVITY_SOURCES): Promise<ActivityItem[]> {
  const lists = await Promise.all(sources.map((source) => source(input)));
  return lists.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_ACTIVITY);
}
