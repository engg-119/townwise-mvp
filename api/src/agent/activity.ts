// TownwiseAI's "What it's been doing" (spec 10.12, docs/portal/tuning-chat.md section 8): real, dated events of the
// location only, read at request time, never an illustration. Each source reads one kind of record; the list merges
// them newest first. Items carry dates, counts and ids, never a file name, a note's detail or a figure.
//
// Sources now: applied sales uploads, notes the caller saved from their own TownwiseAI proposals, answers to
// TownwiseAI's questions (an answer that saved a note shows as that note: a closure note, or a likely-closed day's
// open-day note), and (F3) stored files Townwise read,
// as `file_processed { fileId, firstDate, lastDate, dayCount }`: the upload record a read file writes is then left out,
// so one read shows once. Never the file's name: names stay in the files list, and this panel is read under view-as
// too. A later source appends itself to ACTIVITY_SOURCES. The client renders a kind it does not know as nothing.
//
// D59 (openspec change auto-apply-agent-reads, design decision 11): each change TownwiseAI saved on its own, as
// `agent_change { changeId, action, sourceKind, status, startDate, endDate, noteKind, weekdays, count, undoable }`, dated when it was
// applied, with no title, why, file name or figure (the why is in the log). `undoable` is false under view-as, once a
// person changed the target, and for a caller the action's role refuses. The upload a `sales_days.add` change wrote is
// then left out, so the change shows once.
//
// D65 (openspec change forecast-training-status, design decisions 6 to 8): each finished forecast run of the location
// among its newest calibrations, as `forecast_made { calibrationId, causes, outcome, reason, firstForecast, dayCount,
// firstDate, lastDate, newDays }`, dated when it finished, in the owner codes lab/owner-outcome.ts derives from the
// calibration and what happened to its run (never the staff gate words). A live one past its 20 minutes is listed as a
// failed run without a write, as the calibration answer reads it, so this GET stays a read (7.3); one still inside them
// is the location's updating line, not history. Codes, dates and day counts only: no accuracy and no guest or sales
// figure, for every caller, so the item is the same under view-as. A busy week of TownwiseAI's changes would push every
// run past the cut, so the merge keeps the newest RUNS_KEPT runs first.
//
// D66 (openspec change town-research-agent, design decision 15): each research run that ended with an outcome, of the
// location and of its town (one of the twelve), as `research_done { subject, status, found, added, competitors,
// threadsFailed, finishedAt }`, dated when it finished. Derived from run rows at read time: the counts the merge stored,
// `threadsFailed` the topics that ended `failed` or `budget`, and for the location `competitors`, how many of the events
// it added are competitors' (the location's stored rows the run first found); null for the town. A town run is shared,
// so its item carries its status and counts only, never what started it. A run ended `off` (research stopped) is left
// out, and nothing shows while TOWNWISE_RESEARCH or the organization's switch is off, as the calendar reads none then.
import type { TownwiseContext } from '../app.ts';
import type { MemberPrincipal, OrgScope } from '../access/policy.ts';
import type { AgentChangeAction, AgentChangeStatus, AgentSourceKind } from '../stores/agent-changes.ts';
import type { NoteKind, NoteRecord } from '../stores/notes.ts';
import type { AnswerRecord } from '../stores/agent-answers.ts';
import { ownerCausesOf, ownerOutcomeOf, runningAt, type OwnerCause, type OwnerOutcome, type OwnerReason } from '../lab/owner-outcome.ts';
import { isTownId } from '../research/plan.ts';
import { researchReadable } from '../research/read.ts';
import type { ReportedRunStatus, RunRecordBase, RunStatus, ThreadRecordBase } from '../stores/research-shared.ts';
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
/** D65: the location's calibrations read per request, newest first. */
const CALIBRATIONS_READ = MAX_ACTIVITY;
/** D65: the newest forecast runs the merge keeps whatever else is newer. */
const RUNS_KEPT = 5;
/** D66: research runs read per request, of the location and of its town each, newest first. */
const RESEARCH_RUNS_READ = 5;

export type ActivityItem =
  | { at: string; kind: 'upload_applied'; firstDate: string; lastDate: string; dayCount: number }
  | { at: string; kind: 'note_saved'; via: 'chat' | 'question'; noteId: string; noteKind: NoteKind; startDate: string; endDate: string }
  | { at: string; kind: 'question_answered'; questionId: string; answer: 'open' | 'not_sure' | 'other' }
  | { at: string; kind: 'file_processed'; fileId: string; firstDate: string; lastDate: string; dayCount: number }
  | {
    at: string; kind: 'agent_change'; changeId: string; action: AgentChangeAction; sourceKind: AgentSourceKind; status: AgentChangeStatus;
    startDate: string | null; endDate: string | null; noteKind: NoteKind | null; weekdays: readonly number[] | null; count: number | null;
    undoable: boolean;
  }
  | {
    at: string; kind: 'forecast_made'; calibrationId: string; causes: OwnerCause[]; outcome: OwnerOutcome; reason: OwnerReason;
    firstForecast: boolean; dayCount: number | null; firstDate: string | null; lastDate: string | null; newDays: number | null;
  }
  | {
    at: string; kind: 'research_done'; subject: 'town' | 'location'; status: ReportedRunStatus; found: number; added: number;
    competitors: number | null; threadsFailed: number; finishedAt: string;
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
export const agentChangeSource: ActivitySource = async ({ ctx, scope, locationId, caller }) => {
  const { changes } = await ctx.stores.agentChanges.page(scope, locationId, { limit: CHANGES_READ });
  const shown = changes.filter((change) => change.status !== 'applying');
  const states = await targetStates(ctx, scope, locationId, shown);
  return shown.map((change): SourceItem => ({
    at: change.appliedAt.toISOString(), kind: 'agent_change', changeId: change.id, action: change.action, sourceKind: change.sourceKind,
    status: change.status, startDate: change.startDate, endDate: change.endDate, noteKind: change.noteKind, weekdays: change.weekdays,
    count: change.count, undoable: caller === undefined ? false : undoable(caller, change, states),
    ...(change.action === 'sales_days.add' ? { uploadId: change.targetId } : {}),
  }));
};

/**
 * D65: the location's finished forecast runs among its newest calibrations, and live ones past their 20 minutes as failed
 * runs. A run is the first forecast when no run other than its own had been published by the time it finished; a
 * location whose published runs lapsed is not on its first. One `firstPublished` read serves every item, so a calibration
 * whose run is the location's earliest published one reads as first even if another was published before it finished:
 * only a `not_judged` calibration (its run an older one) can be so, and its words are the same either way.
 */
export const forecastMadeSource: ActivitySource = async ({ ctx, scope, locationId }) => {
  const now = ctx.now();
  const done = (await ctx.stores.calibrations.list(scope, CALIBRATIONS_READ, locationId)).filter((record) => !runningAt(record, now));
  if (done.length === 0) return [];
  const runIds = done.flatMap((record) => (record.runId === null ? [] : [record.runId]));
  const [runs, first] = await Promise.all([
    ctx.stores.forecasts.runStates(scope, runIds), ctx.stores.forecasts.firstPublished(scope, locationId),
  ]);
  return done.flatMap((record): SourceItem[] => {
    const result = ownerOutcomeOf(record, record.runId === null ? null : runs.get(record.runId) ?? null, now);
    if (result === null) return [];
    const firstForecast = first === null || first.runId === record.runId || first.publishedAt > result.finishedAt;
    return [{
      at: result.finishedAt.toISOString(), kind: 'forecast_made', calibrationId: record.id, causes: ownerCausesOf(record),
      outcome: result.outcome, reason: result.reason, firstForecast, dayCount: record.dayCount, firstDate: record.dataFrom,
      lastDate: record.dataThrough, newDays: record.newDays,
    }];
  });
};


// A type import only (test/isolation.test.ts pins who imports research-shared.ts by value): stores' REPORTED_RUN_STATUSES.
const reported = (status: RunStatus): status is ReportedRunStatus => status === 'done' || status === 'partial' || status === 'failed' || status === 'budget';

/** D66: research runs of the location and its town that ended with an outcome; none while research is off for the organization. */
export const researchSource: ActivitySource = async ({ ctx, scope, locationId }) => {
  if (!await researchReadable(ctx, scope)) return [];
  const location = await ctx.stores.locations.find(scope, locationId);
  if (location === null) return [];
  const townId = location.town.townId !== null && isTownId(location.town.townId) ? location.town.townId : null;
  const { researchLocations: own, researchTowns: towns } = ctx.stores;
  const [ownRuns, townRuns] = await Promise.all([
    own.reportedRuns(scope, locationId, RESEARCH_RUNS_READ),
    townId === null ? Promise.resolve([]) : towns.reportedRuns(townId, RESEARCH_RUNS_READ),
  ]);
  const competitorsAdded = await own.competitorsAdded(scope, locationId, ownRuns.map((run) => run.id));
  // A `done` run had no thread fail and a `failed` or `budget` one had all (research/runner.ts runStatus), so only a
  // `partial` run's threads are read.
  const item = async (
    run: RunRecordBase, subject: 'town' | 'location', competitors: number | null, threadsOf: () => Promise<readonly ThreadRecordBase[]>,
  ): Promise<SourceItem[]> => {
    const { status, finishedAt } = run;
    if (!reported(status) || finishedAt === null) return [];
    const threadsFailed = status === 'done' ? 0 : status !== 'partial' ? run.threads.length
      : (await threadsOf()).filter((thread) => thread.status === 'failed' || thread.status === 'budget').length;
    return [{
      at: finishedAt.toISOString(), kind: 'research_done', subject, status, found: run.counts.found, added: run.counts.added, competitors,
      threadsFailed, finishedAt: finishedAt.toISOString(),
    }];
  };
  return (await Promise.all([
    ...ownRuns.map((run) => item(run, 'location', competitorsAdded.get(run.id) ?? 0, () => own.threadsOf(scope, run.id))),
    ...townRuns.map((run) => item(run, 'town', null, () => towns.threadsOf(run.id))),
  ])).flat();
};

/** Append-only: each later source adds one entry. */
export const ACTIVITY_SOURCES: readonly ActivitySource[] = [uploads, savedProposals, answers, files, agentChangeSource, forecastMadeSource, researchSource];

/** The item as the route answers it: without the merge's upload link. */
function published(item: SourceItem): ActivityItem {
  const copy = { ...item };
  Reflect.deleteProperty(copy, 'uploadId');
  return copy;
}

/**
 * Every source's items, newest first, at most MAX_ACTIVITY, the newest RUNS_KEPT forecast runs always among them; an
 * upload a listed file's read wrote shows as that file.
 */
export async function activityFor(input: ActivityInput, sources: readonly ActivitySource[] = ACTIVITY_SOURCES): Promise<ActivityItem[]> {
  const items = (await Promise.all(sources.map((source) => source(input)))).flat();
  const fromFiles = new Set(items.flatMap((item) => (
    (item.kind === 'file_processed' || item.kind === 'agent_change') && item.uploadId !== undefined ? [item.uploadId] : []
  )));
  const sorted = items
    .filter((item) => item.kind !== 'upload_applied' || item.uploadId === undefined || !fromFiles.has(item.uploadId))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  let runsLeft = Math.min(RUNS_KEPT, sorted.filter((item) => item.kind === 'forecast_made').length);
  let room = MAX_ACTIVITY - runsLeft;
  return sorted.filter((item) => {
    if (item.kind === 'forecast_made' && runsLeft > 0) {
      runsLeft -= 1;
      return true;
    }
    if (room === 0) return false;
    room -= 1;
    return true;
  }).map(published);
}
