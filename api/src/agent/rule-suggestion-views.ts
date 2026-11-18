// Suggested closure rules as P29's "Suggested by TownwiseAI" group and P25's "Suggested rules" section list them
// (openspec change suggest-closure-rules, D46): one builder for GET .../rules and GET .../agent. It reads the location's
// open file and sales suggestions and writes nothing (spec 7.3). The rule's words and schedule are Townwise's own; the
// file is named by its item ref and its name (none under view-as, as Your data hides it), or null once it is deleted.
import type { MemberPrincipal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { scheduleSummary } from '../forecasts/reasons.ts';
import type { RuleSuggestionSource, SalesEvidence, SuggestionRecord } from '../stores/agent-suggestions.ts';
import type { RuleSchedule } from '../stores/business-rules.ts';
import type { LocationRecord } from '../stores/locations.ts';
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

/** The location's open file and sales suggestions, oldest first. */
export async function ruleSuggestionViews(ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord): Promise<RuleSuggestionView[]> {
  const { scope } = caller;
  const rows = await ctx.stores.agentSuggestions.listOpenRules(scope, location.id, townToday(ctx, location));
  const fileIds = [...new Set(rows.flatMap((row) => (row.fileId === null ? [] : [row.fileId])))];
  const files = new Map((await ctx.stores.files.byIds(scope, fileIds)).map((file) => [file.id, file]));
  const hidden = caller.viewAs !== null;
  return rows.flatMap((row): RuleSuggestionView[] => {
    if (row.type !== 'rule' || row.source === 'weekly') return [];
    const file = row.fileId === null ? undefined : files.get(row.fileId);
    return [{
      id: row.id, source: row.source, text: row.text, schedule: row.schedule, scheduleSummary: scheduleSummary(row.schedule),
      file: file === undefined ? null : { ref: file.uploadId === null ? `f_${file.id}` : `u_${file.uploadId}`, title: hidden ? null : file.name },
      evidence: row.evidence, canDecide: !hidden,
    }];
  });
}
