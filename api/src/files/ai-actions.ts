// Reading with TownwiseAI (spec 11A.9, D29): acting on a read's answer, as the reader's onRead (files/ai-reader.ts).
// The person opted the file in, so TownwiseAI writes without a second press, and DELETE .../data/:ref/ai undoes it
// all: the file's dated events become notes, its daily totals a sales upload when the file's own text bears them out
// (files/ai-verify.ts), its summary and facts a reference item TownwiseAI can read in chat, and, when it wrote notes or
// days and an org admin asked, a calibration starts as them. [CONFIRM: TownwiseAI writes notes and days from an
// opted-in file without a second press, all undoable] [CONFIRM: a file read may start a calibration for the org admin
// who asked]
//
// No multi-document transactions (DocumentDB): the ids are planned first and saved on the read by compare-and-set,
// each write is keyed by its planned id and skipped when it is already there, and the outcome is recorded last, so a
// retry (the reader calls onRead again on the saved answer, without another model call) completes the work once. Each
// stage first checks that the read is still held under this claim, since the file can be deleted while it is read.
// Nothing here logs a title, a name or a figure; the reader's log line and audit event carry the outcome's counts.
import { isDuplicateKeyError } from '@ckeith26/mongo';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter } from '../audit.ts';
import { EARLIEST_DATE, utcDay } from '../dates.ts';
import { MAX_NOTES, readNoteContent } from '../handlers/notes.ts';
import { checkStart, launch, type StartRefusal, type StartRequest } from '../lab/service.ts';
import { DELETED_PERSON } from '../people.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type {
  AiActionPlan, AiActionsOutcome, AiCalibration, AiCalibrationStatus, AiDaysReason, AiEventEffect, AiItemReason, AiReadEvent,
  AiReadResult, FileAiRead, FileRecord,
} from '../stores/files.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent, NoteEffect, NoteRecord } from '../stores/notes.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import type { OnAiRead } from './ai-reader.ts';
import { verifiedDays } from './ai-verify.ts';
import { saveTextItem, TEXT_ITEM_TITLE_MAX } from './items.ts';

/** A note's detail, at most (spec 12). */
const NOTE_DETAIL_CHARS = 280;
/** Expected guests on a note (spec 12). */
const MAX_EXPECTED_GUESTS = 20_000;
/** The share of the answer's days the file's text must bear out before any is written. [CONFIRM: 95%] */
const VERIFIED_SHARE_PERCENT = 95;

const EFFECTS: Readonly<Record<AiEventEffect, NoteEffect>> = {
  closed: 'closed', more: 'more_guests', fewer: 'fewer_guests', unknown: 'unknown',
};

const REFUSALS: Readonly<Record<StartRefusal, AiCalibrationStatus>> = {
  lab_unavailable: 'lab_unavailable', not_enough_history: 'not_enough_history', invalid_regime_start: 'regime',
  budget_exhausted: 'budget_spent', in_progress: 'in_progress', rate_limited: 'daily_limit', start_failed: 'start_failed',
};

/** `text` stopped at `max` characters, never between the two halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Lower case, each run of white space one space, trimmed: titles compared case- and whitespace-insensitively. */
function folded(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A note's detail from an event: its title, then its own detail when it says more. */
function noteDetailOf(event: AiReadEvent): string {
  const title = event.title.trim();
  const detail = event.detail.trim();
  return cut(detail === '' || folded(detail) === folded(title) ? title : `${title}: ${detail}`, NOTE_DETAIL_CHARS).trim();
}

/** The event as a note, through the notes route's own rules; null when it breaks one (its dates, say). */
function noteContentOf(event: AiReadEvent, today: string): NoteContent | null {
  const effect = EFFECTS[event.effect];
  const guests = event.expectedGuests;
  return readNoteContent({
    kind: event.kind, startDate: event.startDate, endDate: event.endDate, weekdays: null, effect,
    // A count the notes route would refuse (0, or a crowd past a restaurant's) is left out rather than the event.
    expectedGuests: effect === 'closed' || guests === null || guests < 1 || guests > MAX_EXPECTED_GUESTS ? null : guests,
    detail: noteDetailOf(event),
  }, today);
}

/**
 * An existing note says the same as the event: same kind, start and end, and its detail is the event's title (or
 * starts with it and a colon, as a note TownwiseAI made from the same event of another file does).
 */
function duplicates(note: NoteRecord, event: AiReadEvent): boolean {
  if (note.kind !== event.kind || note.startDate !== event.startDate || note.endDate !== event.endDate || note.detail === null) return false;
  const detail = folded(note.detail);
  const title = folded(event.title);
  return detail === title || detail.startsWith(`${title}:`);
}

/** The summary item's title: "TownwiseAI’s notes on" the file's name without its extension, at most 120 characters. */
export function summaryTitle(name: string): string {
  const dot = name.lastIndexOf('.');
  return cut(`TownwiseAI’s notes on ${dot > 0 ? name.slice(0, dot) : name}`, TEXT_ITEM_TITLE_MAX);
}

/** The summary item's text: the summary, then each fact on a "- " line. */
function summaryText(result: AiReadResult): string {
  return result.facts.length === 0 ? result.summary : `${result.summary}\n\n${result.facts.map((fact) => `- ${fact}`).join('\n')}`;
}

/** Why no day may be written from this read, in order; null when the days may be checked against the file's text. */
function daysRefusal(file: FileRecord, result: AiReadResult, sourceText: string | null): AiDaysReason | null {
  if (result.kind !== 'sales') return 'not_sales';
  if (result.days.length === 0) return 'no_days';
  if (file.uploadId !== null || (file.result?.dayCount ?? 0) > 0) return 'file_wrote_days';
  // Never days from a picture: it has no text to check them against.
  if (sourceText === null) return 'picture';
  if (result.confidence !== 'high') return 'not_high_confidence';
  return null;
}

function newPlan(events: number): AiActionPlan {
  const id = (): string => new Types.ObjectId().toHexString();
  return { noteIds: Array.from({ length: events }, id), uploadId: id(), itemId: id(), calibrationId: id() };
}

interface Written { readonly notes: string[]; readonly notesSkipped: AiActionsOutcome['notesSkipped'] }

export function createAiReadActions(ctx: TownwiseContext): OnAiRead {
  const { stores } = ctx;

  /** The person who asked, as the actor of the events a read records (as staff: superadmin, with the grant). */
  async function actorOf(ai: FileAiRead): Promise<Pick<AuditEventInput, 'actorUserId' | 'actorEmail' | 'actorRole' | 'viewAsGrantId'>> {
    const email = (await ctx.authStores.users.findById(ai.requestedBy))?.email ?? DELETED_PERSON;
    return { actorUserId: ai.requestedBy, actorEmail: email, actorRole: ai.requestedByStaff ? 'superadmin' : ai.requestedByRole, viewAsGrantId: ai.requestedGrantId };
  }

  /**
   * Events to notes, at most one a planned id (50 a file): a note already holding its id was written by an earlier
   * attempt; an event the notes route would refuse, one an existing note already says, and any past the location's
   * 1,000 notes are skipped and counted.
   */
  async function writeNotes(scope: OrgScope, file: FileRecord, ai: FileAiRead, result: AiReadResult, plan: AiActionPlan): Promise<Written> {
    const existing = await stores.notes.list(scope, file.locationId);
    const ids = new Set(existing.map((note) => note.id));
    const notes: string[] = [];
    const skipped = { duplicate: 0, cap: 0, invalid: 0 };
    const today = utcDay(ctx.now());
    for (const [index, event] of result.events.entries()) {
      const id = plan.noteIds[index];
      if (id === undefined) break;
      if (ids.has(id)) {
        notes.push(id);
        continue;
      }
      const content = noteContentOf(event, today);
      if (content === null) skipped.invalid += 1;
      else if (existing.some((note) => duplicates(note, event))) skipped.duplicate += 1;
      else if (existing.length >= MAX_NOTES) skipped.cap += 1;
      else {
        try {
          existing.push(await stores.notes.create(scope, file.locationId, content, {
            createdBy: ai.requestedBy, now: ctx.now(), id, ...(ai.requestedByStaff ? { byStaff: true } : {}),
            source: { via: 'ai_file', fileId: file.id },
          }));
        } catch (err) {
          // A takeover of this read wrote it meanwhile.
          if (!isDuplicateKeyError(err)) throw err;
        }
        ids.add(id);
        notes.push(id);
      }
    }
    return { notes, notesSkipped: skipped };
  }

  /**
   * Daily totals to one new upload, through the upload route's store and rules (an org admin's replaces the days it
   * covers, a member's adds new days only), when daysRefusal allows and at least 95% of the days are borne out by the
   * file's text; then only those are written. The upload holds the planned id, so a retry finds it: one still
   * `applying` is applied again (the same days, so the same result), one `applied` is left as it is.
   */
  async function writeDays(
    scope: OrgScope, file: FileRecord, ai: FileAiRead, result: AiReadResult, sourceText: string | null, plan: AiActionPlan, location: LocationRecord,
  ): Promise<Pick<AiActionsOutcome, 'uploadId' | 'daysWritten' | 'daysReason'>> {
    const refusal = daysRefusal(file, result, sourceText);
    if (refusal !== null || sourceText === null) return { uploadId: null, daysWritten: 0, daysReason: refusal ?? 'picture' };
    const now = ctx.now();
    const today = localDay(now, timeZoneOf(location.town).timeZone);
    const latest = utcDay(new Date(`${today}T00:00:00.000Z`), 1);
    const days = verifiedDays(result.days, sourceText, { earliest: EARLIEST_DATE, latest });
    if (days.length === 0 || days.length * 100 < result.days.length * VERIFIED_SHARE_PERCENT) {
      return { uploadId: null, daysWritten: 0, daysReason: 'days_not_verified' };
    }
    const dates = days.map((day) => day.date).sort();
    const firstDate = dates[0] ?? '';
    const lastDate = dates.at(-1) ?? '';
    const replace = ai.requestedByRole === 'org_admin';
    let upload = await stores.uploads.get(scope, file.locationId, plan.uploadId);
    if (upload === null) {
      try {
        upload = await stores.uploads.start(scope, file.locationId, {
          id: plan.uploadId, uploadedBy: ai.requestedBy, uploadedAt: now, dayCount: days.length, firstDate, lastDate,
          hasGuests: days.some((day) => day.guests !== null), hasNetSales: days.some((day) => day.netSalesCents !== null),
          ...(ai.requestedByStaff ? { byStaff: true } : {}), source: { via: 'ai_file', fileId: file.id },
        });
      } catch (err) {
        upload = isDuplicateKeyError(err) ? await stores.uploads.get(scope, file.locationId, plan.uploadId) : null;
        if (upload === null) throw err;
      }
    }
    if (upload.status === 'applying') {
      const applied = await stores.salesDays.apply(scope, file.locationId, { uploadId: upload.id, days, replace, now });
      const held = (await stores.salesDays.ownedDayCounts(scope, [upload.id])).get(upload.id) ?? 0;
      // Applied again after a retry, an add-only upload's own days read as already there, so its counts come from the
      // days it holds; an org admin's counts what this pass found as replaced.
      const counts = replace ? { inserted: applied.inserted, replaced: applied.matched, kept: 0 } : { inserted: held, replaced: 0, kept: days.length - held };
      await stores.uploads.finish(scope, upload.id, counts);
      ctx.logger.info({ orgId: scope.orgId, locationId: file.locationId, uploadId: upload.id, dayCount: days.length }, 'townwise.upload_applied');
      await recordAfter(ctx, {
        ...await actorOf(ai), at: ctx.now(), orgId: scope.orgId, action: 'sales.uploaded', target: { type: 'upload', id: upload.id },
        details: {
          locationId: file.locationId, dayCount: days.length, inserted: counts.inserted, replaced: counts.replaced, firstDate, lastDate,
          fileId: file.id, via: 'townwise_ai',
        },
      });
    }
    const daysWritten = (await stores.salesDays.ownedDayCounts(scope, [upload.id])).get(upload.id) ?? 0;
    return { uploadId: upload.id, daysWritten, daysReason: null };
  }

  /**
   * The summary and facts as a reference text item under the planned id (saveTextItem answers the item a retry finds),
   * added by the person who asked, `townwise_ai`, naming the file it was read from. A cap that refuses it skips it.
   */
  async function keepSummary(
    scope: OrgScope, file: FileRecord, ai: FileAiRead, result: AiReadResult, plan: AiActionPlan,
  ): Promise<Pick<AiActionsOutcome, 'itemId' | 'itemReason'>> {
    const blobs = ctx.files;
    if (blobs === null) throw new Error('stored files are off');
    if (result.summary.trim() === '') return { itemId: null, itemReason: 'no_summary' };
    const saved = await saveTextItem(stores, blobs, scope, file.locationId, {
      id: plan.itemId, title: summaryTitle(file.name), text: summaryText(result), uploadedBy: ai.requestedBy, uploaderRole: ai.requestedByRole,
      ...(ai.requestedByStaff && ai.requestedGrantId !== null ? { openAsAdminGrantId: ai.requestedGrantId } : {}),
      addedVia: 'townwise_ai', source: { via: 'ai_file', fileId: file.id }, now: ctx.now(),
    });
    if (saved === 'storage_full' || saved === 'daily_upload_limit') return { itemId: null, itemReason: saved satisfies AiItemReason };
    if (saved.created) {
      const item = saved.file;
      await recordAfter(ctx, {
        ...await actorOf(ai), at: ctx.now(), orgId: scope.orgId, action: 'file.uploaded', target: { type: 'file', id: item.id },
        details: { locationId: item.locationId, kind: item.kind, sizeBytes: item.sizeBytes, purpose: item.purpose, via: 'townwise_ai' },
      });
      ctx.logger.info({ fileId: item.id, kind: item.kind, sizeBytes: item.sizeBytes, purpose: item.purpose, durationMs: 0 }, 'townwise.file_stored');
    }
    return { itemId: saved.file.id, itemReason: null };
  }

  /**
   * The model update: when the read wrote notes or days and an org admin asked, a calibration as them (staff open as
   * admin start it as staff) through the lab's own checks, under the planned id, so a retry finds the one it started.
   * Publishing stays behind staff's forecasts switch. A refusal is recorded, never a failure of the read.
   */
  async function calibrate(
    scope: OrgScope, ai: FileAiRead, plan: AiActionPlan, location: LocationRecord, wrote: boolean,
  ): Promise<AiCalibration> {
    if (!wrote) return { status: 'not_needed', id: null };
    if (ai.requestedByRole !== 'org_admin') return { status: 'not_admin', id: null };
    const earlier = await stores.calibrations.find(scope, plan.calibrationId);
    if (earlier !== null) return earlier.failure === 'start_failed' ? { status: 'start_failed', id: null } : { status: 'started', id: earlier.id };
    if ((await stores.orgs.findById(scope.orgId))?.status !== 'active') return { status: 'org_not_active', id: null };
    const request: StartRequest = {
      id: plan.calibrationId, scope, location,
      requester: { userId: ai.requestedBy, role: ai.requestedByStaff ? 'superadmin' : 'org_admin', via: 'file' },
      regimeStart: null, today: localDay(ctx.now(), timeZoneOf(location.town).timeZone),
    };
    const refusal = await checkStart(ctx, request);
    if (refusal !== null) return { status: REFUSALS[refusal], id: null };
    const launched = await launch(ctx, request);
    // A job that couldn't start leaves a calibration failed start_failed, so its request is recorded too.
    if (launched.ok || launched.code === 'start_failed') {
      await recordAfter(ctx, {
        ...await actorOf(ai), at: ctx.now(), orgId: scope.orgId, action: 'calibration.requested', target: { type: 'calibration', id: request.id },
        details: { locationId: location.id, calibrationId: request.id, via: 'file', hasRegime: false },
      });
    }
    return launched.ok ? { status: 'started', id: launched.calibration.id } : { status: REFUSALS[launched.code], id: null };
  }

  /**
   * onRead: the plan saved (or an earlier attempt's found), then notes, days, the summary item and the model update,
   * each only while the read is still held under this claim, then the outcome. A read no longer held writes nothing more.
   */
  return async (scope, file, read, sourceText) => {
    const ai = file.ai;
    if (ai === null) return;
    const attempt = ai.attempts;
    const plan = (await stores.files.planAiActions(scope, file.id, attempt, newPlan(read.result.events.length)))?.ai?.actions?.plan;
    if (plan === undefined) return;
    const held = async (): Promise<boolean> => {
      const now = await stores.files.get(scope, file.locationId, file.id);
      return now !== null && now.status !== 'deleting' && now.ai?.status === 'reading' && now.ai.attempts === attempt;
    };
    const location = await stores.locations.find(scope, file.locationId);
    if (location === null) return;
    const { result } = read;
    const written = await writeNotes(scope, file, ai, result, plan);
    if (!await held()) return;
    const days = await writeDays(scope, file, ai, result, sourceText, plan, location);
    if (!await held()) return;
    const item = await keepSummary(scope, file, ai, result, plan);
    if (!await held()) return;
    const calibration = await calibrate(scope, ai, plan, location, written.notes.length > 0 || days.daysWritten > 0);
    await stores.files.recordAiActions(scope, file.id, attempt, { ...written, ...days, ...item, calibration });
  };
}
