import { ApiError } from '../../api/client';
import { formatCount, formatDate } from '../format';
import { WEEKDAYS } from '../locations/noteRules';
import type { RuleSuggestion } from './api';

// A suggested closure rule in words (openspec change suggest-closure-rules, D46): P29's "Suggested by TownwiseAI" group
// and P25's "Suggested rules" share them. The rule's words and what it does come from the API (`text`,
// `scheduleSummary`), never written again here; this says where it came from and why a decision was refused. Pinned by
// test/portal/rules/suggestions.test.ts.

export const SUGGESTED_COPY = {
  heading: 'Suggested by TownwiseAI',
  panelHeading: 'Suggested rules',
  lead: 'TownwiseAI found these in your files and sales history. Each changes nothing until someone on your team confirms it.',
  help: 'Confirm saves it as a business rule, and the forecast uses its schedule from then on. Edit changes it first. Dismiss and TownwiseAI won’t suggest it again.',
  dismissed: 'Dismissed. TownwiseAI won’t suggest it again.',
  saving: 'Saving…',
  editExisting: 'Edit that rule',
  openRules: 'Open Business rules',
  gone: 'That suggestion was already decided, or its dates have passed.',
  fileHidden: 'From a file TownwiseAI read',
  fileGone: 'From a file you deleted',
} as const;

/** "2 to decide": the group's eyebrow. */
export function toDecideLine(count: number): string {
  return `${formatCount(count)} to decide`;
}

/** What Confirm or Edit saved, on the panel's card. */
export function confirmedLine(text: string): string {
  return `Added the business rule “${text}”.`;
}

/** 409 already_decided: the rule a racing Confirm or Edit saved first. */
export function alreadyLine(text: string): string {
  return `Already confirmed as: ${text}`;
}

/** "Mondays" for the weekday a sales suggestion is about (0 is Sunday). */
function weekdayPlural(schedule: RuleSuggestion['schedule']): string {
  const day = schedule.weekdays?.[0];
  return WEEKDAYS.find((each) => each.value === day)?.plural ?? 'days';
}

/**
 * Where it came from: the file (its name, linked to its page by `ref`; no name under view-as; or that it was deleted),
 * or the sales history's days: the last day of that weekday with sales, then how many had none.
 */
export function originOf(suggestion: RuleSuggestion): { text: string; ref: string | null } {
  if (suggestion.source === 'file') {
    const { file } = suggestion;
    if (file === null) return { text: SUGGESTED_COPY.fileGone, ref: null };
    return { text: file.title === null ? SUGGESTED_COPY.fileHidden : `From ${file.title}`, ref: file.ref };
  }
  const plural = weekdayPlural(suggestion.schedule);
  const evidence = suggestion.evidence;
  if (evidence === null) return { text: `From your sales history of ${plural}.`, ref: null };
  const counts = `${formatCount(evidence.noSalesCount)} of ${formatCount(evidence.weekdayCount)} ${plural} had no sales.`;
  if (evidence.lastSalesDate === null) return { text: `In your sales history, ${counts}`, ref: null };
  return { text: `No sales on any ${plural.slice(0, -1)} since ${formatDate(evidence.lastSalesDate)}. In all, ${counts}`, ref: null };
}

/** Why Confirm, Edit or Dismiss was refused. 409 already_decided and a 404 are each answered by the page, not here. */
export function decideErrorLine(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'rule_limit') return 'This location has 30 rules, the most it can hold. Delete one to confirm this.';
    if (error.code === 'rule_exists') return 'A rule with these words is saved without a schedule. Add the schedule to it on Business rules.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t confirm or dismiss suggestions.';
    if (error.status === 429) return 'You’ve made a lot of changes. Try again later.';
  }
  return 'Couldn’t save that. Try again.';
}
