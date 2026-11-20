// Suggested closure rules as P29's "Suggested by TownwiseAI" group and P25's "Suggested rules" section list them
// (openspec change suggest-closure-rules, D46): one builder for GET .../rules and GET .../agent. It reads the location's
// open file and sales suggestions and writes nothing (spec 7.3). The rule's words and schedule are Townwise's own; the
// file is named by its item ref and its name (none under view-as, as Your data hides it), or null once it is deleted.
// The sales history's suggestions are computed on read: listed as `sales_weekday_{d}` while no row holds their closure
// key, and stored only when someone decides one (handlers/rule-suggestions.ts); once a row holds the key it is listed
// under its own id while open, and hidden otherwise.
import type { MemberPrincipal, OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { scheduleSummary } from '../forecasts/reasons.ts';
import { closureKeyOf, closureRuleText } from './closure-suggestions.ts';
import { questionWindow, salesSuggestionsFor, weekdayEvidence, type SalesSuggestion } from './questions.ts';
import type { RuleSuggestionSource, SalesEvidence, SuggestionRecord } from '../stores/agent-suggestions.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { NoteContent } from '../stores/notes.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';

/** A suggested closure rule as the cards show it. */
export interface RuleSuggestionView {
  /** The stored suggestion's id. */
  id: string;
  source: RuleSuggestionSource;
  /** Townwise's words for the rule, from its schedule. */
  text: string;
  schedule: RuleSchedule;
  scheduleSummary: string;
  /** The file a file suggestion came from: its Your data ref, and its name (null under view-as); null once it is deleted. */
  file: { ref: string; title: string | null } | null;
  /** A sales suggestion's day counts and last day with sales; null otherwise. */
  evidence: SalesEvidence | null;
  /** Any member outside view-as confirms, edits or dismisses it. */
  canDecide: boolean;
}

/** The town's today for a location. */
export function townToday(ctx: Pick<TownwiseContext, 'now'>, location: LocationRecord): string {
  return localDay(ctx.now(), timeZoneOf(location.town).timeZone);
}

/** Open, and its end (if any) is today or later in the town: a file or sales suggestion that may still be decided. */
export function isLive(record: SuggestionRecord, today: string): boolean {
  if (record.type !== 'rule') return false;
  return record.status === 'open' && (record.schedule.endDate === null || record.schedule.endDate >= today);
}

/** A sales suggestion's id while it is computed, not stored: `sales_weekday_{d}`, 0 (Sunday) to 6. */
export const SALES_ID = /^sales_weekday_([0-6])$/;

/**
 * The sales history's suggestions at the location now (questions.ts weekdayEvidence and salesSuggestionsFor), with no
 * row checked: the window's days, its turned-off days, the done answers and the location's rules.
 */
export async function salesSuggestions(ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, locationId: string): Promise<SalesSuggestion[]> {
  const { salesDays, agentAnswers, businessRules } = ctx.stores;
  const coverage = await salesDays.coverage(scope, locationId);
  const window = questionWindow(coverage);
  if (window === null) return [];
  const [days, turnedOff, answers] = await Promise.all([
    salesDays.days(scope, locationId, window), salesDays.disabledDates(scope, locationId, window), agentAnswers.list(scope, locationId),
  ]);
  const evidence = weekdayEvidence({ coverage, days, notes: [], answered: [], turnedOff });
  if (evidence.length === 0) return [];
  return salesSuggestionsFor({
    evidence, answers: answers.filter((row) => row.status === 'done'), rules: await businessRules.list(scope, locationId), takenKeys: new Set(),
  });
}

/** The location's open file and sales suggestions, oldest first, then the sales history's not yet stored. */
export async function ruleSuggestionViews(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord): Promise<RuleSuggestionView[]> {
  const { scope } = caller;
  const rows = await ctx.stores.agentSuggestions.listOpenRules(scope, location.id, townToday(ctx, location));
  const fileIds = [...new Set(rows.flatMap((row) => (row.fileId === null ? [] : [row.fileId])))];
  const files = new Map((await ctx.stores.files.byIds(scope, fileIds)).map((file) => [file.id, file]));
  const hidden = caller.viewAs !== null;
  const computed: RuleSuggestionView[] = [];
  for (const each of await salesSuggestions(ctx, scope, location.id)) {
    // A row with the key is listed below while open (a file's, or this one stored), and hidden once decided.
    if (await ctx.stores.agentSuggestions.findByKey(scope, location.id, closureKeyOf(each.schedule)) !== null) continue;
    computed.push({
      id: `sales_weekday_${String(each.weekday)}`, source: 'sales', text: closureRuleText(each.schedule), schedule: each.schedule,
      scheduleSummary: scheduleSummary(each.schedule), file: null, evidence: each.evidence, canDecide: !hidden,
    });
  }
  const stored = rows.flatMap((row): RuleSuggestionView[] => {
    if (row.type !== 'rule' || row.source === 'weekly') return [];
    const file = row.fileId === null ? undefined : files.get(row.fileId);
    return [{
      id: row.id, source: row.source, text: row.text, schedule: row.schedule, scheduleSummary: scheduleSummary(row.schedule),
      file: file === undefined ? null : { ref: file.uploadId === null ? `f_${file.id}` : `u_${file.uploadId}`, title: hidden ? null : file.name },
      evidence: row.evidence, canDecide: !hidden,
    }];
  });
  return [...stored, ...computed];
}

/**
 * D59: an event a file read was not sure of (or that conflicts with a person's note or rule), as its card shows it: the
 * note accepting writes, and the file it came from. Under view-as the note's title and detail are left out, as a read's
 * event titles are (spec 11A.9).
 */
export interface NoteSuggestionView {
  id: string;
  source: 'file';
  note: NoteContent;
  file: { ref: string; title: string | null } | null;
  /** Any member outside view-as confirms or dismisses it. */
  canDecide: boolean;
}

/** D59: the location's open note suggestions from files that end today or later, oldest first. */
export async function noteSuggestionViews(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord): Promise<NoteSuggestionView[]> {
  const { scope } = caller;
  const rows = await ctx.stores.agentSuggestions.listOpenFileNotes(scope, location.id, townToday(ctx, location));
  const fileIds = [...new Set(rows.flatMap((row) => (row.fileId === null ? [] : [row.fileId])))];
  const files = new Map((await ctx.stores.files.byIds(scope, fileIds)).map((file) => [file.id, file]));
  const hidden = caller.viewAs !== null;
  return rows.flatMap((row): NoteSuggestionView[] => {
    if (row.type !== 'note') return [];
    const file = row.fileId === null ? undefined : files.get(row.fileId);
    return [{
      id: row.id, source: 'file', note: hidden ? { ...row.note, title: null, detail: null } : row.note,
      file: file === undefined ? null : { ref: file.uploadId === null ? `f_${file.id}` : `u_${file.uploadId}`, title: hidden ? null : file.name },
      canDecide: !hidden,
    }];
  });
}
