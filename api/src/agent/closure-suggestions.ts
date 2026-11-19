// Suggested closure rules (openspec change suggest-closure-rules, D46): what a file read or the sales history suggests
// is a closure schedule, never words from the file or a model. Pure: the closure key a suggestion is deduped on (one per
// key at a location in any status, the unique index of stores/agent-suggestions.ts), the words Townwise writes for it,
// whether a location's rules already make it pointless, and (D59 slice 3) whether the sales history is sure of it.
import { isClosure } from '../closed-days.ts';
import { dateWords, monthDayWords, weekdayList } from '../forecasts/reasons.ts';
import type { SalesEvidence } from '../stores/agent-suggestions.ts';
import { ruleKey, type BusinessRuleRecord, type RuleSchedule } from '../stores/business-rules.ts';

/**
 * The closure key: the weekdays (sorted, or `*`), then a dated range's start and end, a season's `yearly=` months and
 * days, or `ongoing` for a standing rule. A standing or yearly rule's key ignores its start, so a file's "Closed Mondays"
 * and the sales history's Mondays are one rule. `closed|w=1|ongoing`, `closed|w=*|2027-01-04..2027-03-31`,
 * `closed|w=*|yearly=01-01..03-31`.
 */
export function closureKeyOf(schedule: RuleSchedule): string {
  const weekdays = schedule.weekdays === null ? '*' : [...schedule.weekdays].sort((a, b) => a - b).join(',');
  const season = schedule.season ?? null;
  const when = season !== null ? `yearly=${season.from}..${season.to}`
    : schedule.endDate === null ? 'ongoing' : `${schedule.startDate}..${schedule.endDate}`;
  return `closed|w=${weekdays}|${when}`;
}

/**
 * D59 slice 3: the sales history is sure of a closed weekday (beyond D46's bar of 60% of at least 4 counted days, with
 * none of its last 4 having sales) when at least 8 of its days were counted and at least 90% of them had no sales; the
 * weekly pass then adds it as a rule on its own. [CONFIRM: TownwiseAI adds a closed weekday on its own when at least 90%
 * of at least 8 counted days had no sales]
 */
export const SURE_SALES_MIN_DAYS = 8;
export const SURE_SALES_SHARE = 0.9;

export function salesEvidenceSure(evidence: Pick<SalesEvidence, 'noSalesCount' | 'weekdayCount'>): boolean {
  return evidence.weekdayCount >= SURE_SALES_MIN_DAYS && evidence.noSalesCount >= SURE_SALES_SHARE * evidence.weekdayCount;
}

/** A dated range in words: "Jan 4 to Mar 31, 2027", "Dec 20, 2026 to Jan 5, 2027", or one day "Jan 4, 2027". */
function rangeWords(startDate: string, endDate: string): string {
  if (startDate === endDate) return dateWords(startDate);
  const sameYear = startDate.slice(0, 4) === endDate.slice(0, 4);
  return `${sameYear ? monthDayWords(startDate.slice(5)) : dateWords(startDate)} to ${dateWords(endDate)}`;
}

/**
 * A suggested closure rule's words, from its schedule alone: "Closed on Mondays", "Closed Jan 4 to Mar 31, 2027",
 * "Closed on Mondays, Jan 1 to Mar 31 every year".
 */
export function closureRuleText(schedule: RuleSchedule): string {
  const days = weekdayList(schedule.weekdays);
  const season = schedule.season ?? null;
  const when = season !== null ? `${monthDayWords(season.from)} to ${monthDayWords(season.to)} every year`
    : schedule.endDate === null ? null : rangeWords(schedule.startDate, schedule.endDate);
  if (days === null) return when === null ? 'Closed' : `Closed ${when}`;
  return when === null ? `Closed on ${days}` : `Closed on ${days}, ${when}`;
}

/** Whether `rule`, an ongoing closure, closes every weekday `schedule` (standing) closes. */
function closesWeekdays(rule: RuleSchedule, schedule: RuleSchedule): boolean {
  if (rule.endDate !== null || (rule.season ?? null) !== null || rule.startTime !== null) return false;
  const ruled = rule.weekdays;
  if (ruled === null) return true;
  return schedule.weekdays?.every((day) => ruled.includes(day)) ?? false;
}

/**
 * Whether a closure `schedule` is worth suggesting at a location with these rules: not when a closure rule already
 * covers it (for a standing one, an ongoing closure on the same weekdays or more; otherwise one with the same closure
 * key), nor when a rule with a schedule has its words in any case. A rule with the words and no schedule closes nothing,
 * so it does not block it (confirming then answers 409 rule_exists).
 */
export function isSuggestable(schedule: RuleSchedule, context: { readonly rules: readonly Pick<BusinessRuleRecord, 'text' | 'schedule'>[] }): boolean {
  const standing = schedule.endDate === null && (schedule.season ?? null) === null;
  const key = closureKeyOf(schedule);
  const words = ruleKey(closureRuleText(schedule));
  return !context.rules.some(({ text, schedule: ruled }) => {
    if (ruled === null) return false;
    if (ruleKey(text) === words) return true;
    if (!isClosure(ruled)) return false;
    return standing ? closesWeekdays(ruled, schedule) : closureKeyOf(ruled) === key;
  });
}
