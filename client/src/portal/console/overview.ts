import { formatCount, formatDate, plural } from '../format';
import { orgHref, requestHref } from './links';
import {
  ACTION_GROUPS, OVERVIEW_DAYS, type ActionGroup, type AttentionItem, type Overview, type OverviewDay, type OverviewDays,
  type OverviewLocation, type OverviewOrg,
} from './schemas';

// The staff Overview's words (P32, openspec change staff-overview, design decision 7), as pure functions of the answer:
// the window, each tile's change against the window before, Needs attention's lines and links, the action groups'
// names, money, a location's forecast and the activity summary. Days are UTC, as the API counts them.

/** `?days=`: 7, 28 or 90; anything else, or none, is 28. */
export function overviewDaysOf(value: string | string[] | undefined): OverviewDays {
  return OVERVIEW_DAYS.find((days) => String(days) === value) ?? 28;
}

export function overviewHref(days: OverviewDays): string {
  return `/admin/overview?days=${String(days)}`;
}

/**
 * The line under the window tabs: the window the figures below are for, or, while the next window loads, what is
 * loading and which window the figures still on the page are for. `shown` is the answer on the page, null before one.
 */
export function windowLine(days: OverviewDays, shown: Overview['window'] | null, loading: boolean): string {
  if (shown !== null && !loading) return `The last ${String(shown.days)} days, ${formatDate(shown.from)} to ${formatDate(shown.to)} (UTC).`;
  const next = `Loading the last ${String(days)} days…`;
  return shown === null ? next : `${next} Below: the last ${String(shown.days)} days until then.`;
}

/** “Up 3 from the 28 days before”, “Same as …”, “Down 2 from …”, or “No earlier days recorded” with no previous value. */
export function changeWords(count: number, previous: number | null, days: number): string {
  if (previous === null) return 'No earlier days recorded';
  const before = `the ${String(days)} days before`;
  const diff = count - previous;
  if (diff === 0) return `Same as ${before}`;
  return `${diff > 0 ? 'Up' : 'Down'} ${formatCount(Math.abs(diff))} from ${before}`;
}

export interface Tile {
  key: string;
  label: string;
  value: string;
  /** “of 14”: the active organizations someone has joined, or the active seats. */
  of: string | null;
  change: string;
}

/** The six tiles, in the page's order. */
export function tilesOf(overview: Overview): Tile[] {
  const { totals, window } = overview;
  const days = window.days;
  const activity = (key: string, label: string, total: { count: number; previous: number | null; of: number }): Tile => ({
    key, label, value: formatCount(total.count), of: `of ${formatCount(total.of)}`, change: changeWords(total.count, total.previous, days),
  });
  const count = (key: string, label: string, total: { count: number; previous: number }): Tile => ({
    key, label, value: formatCount(total.count), of: null, change: changeWords(total.count, total.previous, days),
  });
  return [
    activity('activeOrgs', 'Active organizations', totals.activeOrgs),
    activity('activePeople', 'Active people', totals.activePeople),
    count('chatTurns', 'TownwiseAI turns', totals.chatTurns),
    count('salesUploads', 'Sales uploads', totals.salesUploads),
    count('notesWritten', 'Notes written', totals.notesWritten),
    count('orderDecisions', 'Order decisions', totals.orderDecisions),
  ];
}

/**
 * The line above the tiles: from when active days are recorded, or, with none yet, why the activity figures read 0.
 */
export function recordingLine(recordingSince: string | null): string {
  if (recordingSince === null) {
    return 'No activity is recorded yet. Active people and organizations count from the first day a member or org admin opens the app, so they read 0 until then. The other figures come from the audit log.';
  }
  return `Active days recorded since ${formatDate(recordingSince)}. Days are UTC.`;
}

/** The action groups' names, in the chart's stacking order. */
export const GROUP_LABEL: Readonly<Record<ActionGroup, string>> = {
  uploads: 'Uploads and data',
  notes: 'Notes, rules and calendars',
  townwiseAi: 'TownwiseAI',
  orders: 'Orders',
  team: 'Team and settings',
};

export function dayActions(day: OverviewDay): number {
  return ACTION_GROUPS.reduce((sum, group) => sum + day.actions[group], 0);
}

/** The chart's summary: actions recorded by group, and the day the most people were active. */
export function activitySummary(series: readonly OverviewDay[], days: number): string {
  const window = `the last ${String(days)} days (UTC)`;
  const total = series.reduce((sum, day) => sum + dayActions(day), 0);
  const busiest = series.reduce<OverviewDay | null>((best, day) => (best === null || day.activePeople > best.activePeople ? day : best), null);
  if (total === 0 && (busiest === null || busiest.activePeople === 0)) return `No one was active and no actions were recorded in ${window}.`;
  const groups = ACTION_GROUPS.map((group) => `${formatCount(series.reduce((sum, day) => sum + day.actions[group], 0))} ${GROUP_LABEL[group]}`);
  const actions = `${plural(total, 'action', 'actions')} recorded in ${window}: ${groups.join(', ')}.`;
  if (busiest === null || busiest.activePeople === 0) return `${actions} No one was active on any day.`;
  return `${actions} The most people active on one day: ${formatCount(busiest.activePeople)}, on ${formatDate(busiest.day)}.`;
}

/** “$4.10”, or “$20” for whole dollars. */
export function usd(microUsd: number): string {
  const cents = Math.round(microUsd / 10_000);
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `$${formatCount(whole)}` : `$${formatCount(whole)}.${String(rest).padStart(2, '0')}`;
}

/** TownwiseAI this month: “$4.10 of $20”, or “$4.10, no budget” while the budget is 0. */
export function spendWords(chat: OverviewOrg['chat']): string {
  return chat.budgetMicroUsd > 0 ? `${usd(chat.spentMicroUsd)} of ${usd(chat.budgetMicroUsd)}` : `${usd(chat.spentMicroUsd)}, no budget`;
}

/** “Typical error 12.4% over 21 days, 17 in range”, or what stands in its place. */
export function accuracyWords(accuracy: OverviewLocation['accuracy']): string {
  if (accuracy === null || accuracy.days === 0) return 'No scored days yet';
  const inRange = `${formatCount(accuracy.inRange)} in range`;
  if (accuracy.typicalErrorPct === null) return `${plural(accuracy.days, 'scored day', 'scored days')}, too few for a typical error, ${inRange}`;
  return `Typical error ${accuracy.typicalErrorPct.toFixed(1)}% over ${plural(accuracy.days, 'day', 'days')}, ${inRange}`;
}

const ENGINE: Readonly<Record<string, string>> = { model: 'model', baseline: 'baseline' };

/**
 * A location's forecast over the window's passed days. `newestRun` is the newest run used on those days, which may be
 * older than the newest published, so the words say “used”.
 */
export function forecastWords(location: OverviewLocation): string {
  if (location.newestRun === null) return 'No published forecast on these days';
  const run = location.newestRun;
  const engine = ENGINE[run.engine] ?? run.engine;
  return `Newest run used: made ${formatDate(run.madeAt)}, ${engine}, data through ${formatDate(run.dataThrough)}. ${accuracyWords(location.accuracy)}`;
}

export interface AttentionLine {
  key: string;
  text: string;
  link: { label: string; href: string } | null;
}

function possessive(name: string): string {
  return `${name}’s`;
}

/** Needs attention's line and link for one item; null for a kind this client does not know. */
export function attentionLine(item: AttentionItem, orgs: readonly OverviewOrg[]): AttentionLine | null {
  const org = item.orgId === null ? undefined : orgs.find((each) => each.id === item.orgId);
  const name = org?.name ?? 'An organization';
  const since = item.since === null ? null : formatDate(item.since);
  const open = item.orgId === null ? null : { label: `Open ${org?.name ?? 'the organization'}`, href: orgHref(item.orgId) };
  const key = `${item.kind}:${item.requestId ?? item.orgId ?? ''}`;
  switch (item.kind) {
    case 'request_waiting':
      return {
        key,
        text: since === null ? 'An access request is waiting.' : `An access request has waited since ${since}.`,
        link: item.requestId === null ? { label: 'Open requests', href: '/admin' } : { label: 'Open the request', href: requestHref('pending', item.requestId) },
      };
    case 'refresh_off':
      return { key, text: 'The weekly refresh isn’t running on this server: the forecast lab or its switch is off.', link: null };
    case 'refresh_paused':
      return {
        key,
        text: since === null ? 'Staff paused the weekly refresh.' : `Staff paused the weekly refresh on ${since}.`,
        link: { label: 'Open organizations', href: '/admin/orgs' },
      };
    case 'refresh_failed': {
      const count = item.count ?? 1;
      const at = since === null ? '' : `, the first on ${since}`;
      return { key, text: `${possessive(name)} weekly refresh failed at ${plural(count, 'location', 'locations')}${at}.`, link: open };
    }
    case 'no_recent_upload':
      return { key, text: since === null ? `${name} has never uploaded sales.` : `${name} has had no upload since ${since}.`, link: open };
    case 'in_setup':
      return { key, text: since === null ? `${name} is in staff setup.` : `${name} has been in staff setup since ${since}.`, link: open };
    case 'invites_waiting': {
      const count = item.count ?? 1;
      const verb = count === 1 ? 'is' : 'are';
      const oldest = since === null ? '' : count === 1 ? ` since ${since}` : `, the oldest since ${since}`;
      return { key, text: `${plural(count, 'invitation', 'invitations')} to ${name} ${verb} unanswered${oldest}.`, link: open };
    }
    case 'chat_budget': {
      const share = org === undefined || org.chat.budgetMicroUsd <= 0 ? null : Math.floor((org.chat.spentMicroUsd / org.chat.budgetMicroUsd) * 100);
      const used = share === null ? 'most' : `${String(share)}%`;
      return { key, text: `${name} has used ${used} of this month’s TownwiseAI budget.`, link: open };
    }
    default:
      return null;
  }
}

/** Needs attention's lines, in the server's order, skipping kinds this client does not know. */
export function attentionLines(overview: Overview): AttentionLine[] {
  return overview.attention.flatMap((item) => {
    const line = attentionLine(item, overview.orgs);
    return line === null ? [] : [line];
  });
}
