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

/** “Up 3 from the 28 days before”, “Same as …”, “Down 2 from …”, or “Not enough history to compare” with no previous value. */
export function changeWords(count: number, previous: number | null, days: number): string {
  if (previous === null) return 'Not enough history to compare';
  const before = `the ${String(days)} days before`;
  const diff = count - previous;
  if (diff === 0) return `Same as ${before}`;
  return `${diff > 0 ? 'Up' : 'Down'} ${formatCount(Math.abs(diff))} from ${before}`;
}

export interface Tile {
  key: string;
  label: string;
  /** The figure; null when there is none to show, and `detail` says why. */
  value: string | null;
  /** What the figure is out of, said in full: “of 6 with people in them”. */
  of: string | null;
  /** The change against the window before, in words, or for the forecast tiles what the figure counts. */
  detail: string;
}

/**
 * Forecast health over the window's passed days, from the rows' locations: scored days and those in range, summed over
 * the locations with a scored window, and the locations with a published forecast used on those days, of all.
 */
export function forecastHealth(orgs: readonly OverviewOrg[]): { scored: number; inRange: number; published: number; locations: number } {
  const locations = orgs.flatMap((org) => org.locations);
  const scored = locations.flatMap((location) => (location.accuracy === null || location.accuracy.days === 0 ? [] : [location.accuracy]));
  return {
    scored: scored.reduce((sum, accuracy) => sum + accuracy.days, 0),
    inRange: scored.reduce((sum, accuracy) => sum + accuracy.inRange, 0),
    published: locations.filter((location) => location.newestRun !== null).length,
    locations: locations.length,
  };
}

/** A whole percent, rounded. */
function percent(part: number, whole: number): string {
  return `${String(Math.round((100 * part) / whole))}%`;
}

/**
 * The eight tiles, in the page's order: who used the app and how the forecasts did (the first row from 1024px), then
 * what people did. Never a bare “active”: the table's Status says that of an organization that is not suspended.
 */
export function tilesOf(overview: Overview): Tile[] {
  const { totals, window } = overview;
  const days = window.days;
  const health = forecastHealth(overview.orgs);
  const count = (key: string, label: string, total: { count: number; previous: number | null }, of: string | null = null): Tile => ({
    key, label, value: formatCount(total.count), of, detail: changeWords(total.count, total.previous, days),
  });
  return [
    count('activeOrgs', 'Organizations that used the app', totals.activeOrgs, `of ${formatCount(totals.activeOrgs.of)} with people in them`),
    count('activePeople', 'People who used the app', totals.activePeople, `of ${formatCount(totals.activePeople.of)} members and org admins`),
    health.scored === 0
      ? { key: 'inRange', label: 'Forecast days in range', value: null, of: null, detail: 'No forecast days scored yet' }
      : {
        key: 'inRange', label: 'Forecast days in range', value: percent(health.inRange, health.scored), of: null,
        detail: `In range on ${formatCount(health.inRange)} of ${plural(health.scored, 'scored day', 'scored days')}`,
      },
    {
      key: 'published', label: 'Locations with a published forecast', value: formatCount(health.published),
      of: `of ${plural(health.locations, 'location', 'locations')}`, detail: `Used on the last ${String(days)} days`,
    },
    count('chatTurns', 'TownwiseAI turns', totals.chatTurns),
    count('salesUploads', 'Sales uploads', totals.salesUploads),
    count('notesWritten', 'Notes written', totals.notesWritten),
    count('orderDecisions', 'Order decisions', totals.orderDecisions),
  ];
}

/** The line under the tiles: who counts, what an action is, and that days are UTC. */
export const TILES_NOTE = 'Used the app: a member or org admin opened Townwise that day (staff never count). Actions are recorded changes, not page views. Days are UTC.';

/**
 * The line above the tiles: from when days of use are recorded, or, with none yet, why the use figures read 0.
 */
export function recordingLine(recordingSince: string | null): string {
  if (recordingSince === null) {
    return 'No use of the app is recorded yet. Organizations and people that used the app count from the first day a member or org admin opens it, so they read 0 until then. The other figures come from the audit log.';
  }
  return `Days of use recorded since ${formatDate(recordingSince)}.`;
}

/** The action groups' names, in the chart's stacking order. */
export const GROUP_LABEL: Readonly<Record<ActionGroup, string>> = {
  uploads: 'Uploads and data',
  notes: 'Notes, rules and calendars',
  townwiseAi: 'TownwiseAI',
  orders: 'Orders',
  team: 'Team and settings',
};

/** The groups' names mid-sentence: lower case, but TownwiseAI keeps its name. */
export function groupWords(group: ActionGroup): string {
  const label = GROUP_LABEL[group];
  return group === 'townwiseAi' ? label : label.toLowerCase();
}

export function dayActions(day: Pick<OverviewDay, 'actions'>): number {
  return ACTION_GROUPS.reduce((sum, group) => sum + day.actions[group], 0);
}

/** One bar of the activity chart: a day, or a week of days from `from` to `to`. */
export interface ChartBar {
  from: string;
  to: string;
  /** People who used the app that day; for a week, the most on one of its days (people are not summed across days). */
  activePeople: number;
  actions: Readonly<Record<ActionGroup, number>>;
}

/**
 * The chart's bars, oldest first: one per day, or with `weekly` one per 7 days counted back from the newest day (so the
 * oldest may be shorter), with the week's actions summed and the most people on one of its days.
 */
export function chartBars(series: readonly OverviewDay[], weekly: boolean): ChartBar[] {
  if (!weekly) return series.map((day) => ({ from: day.day, to: day.day, activePeople: day.activePeople, actions: day.actions }));
  const bars: ChartBar[] = [];
  for (let end = series.length; end > 0; end -= 7) {
    const days = series.slice(Math.max(0, end - 7), end);
    const first = days[0];
    const last = days[days.length - 1];
    if (first === undefined || last === undefined) continue;
    bars.unshift({
      from: first.day, to: last.day,
      activePeople: Math.max(...days.map((day) => day.activePeople)),
      actions: Object.fromEntries(ACTION_GROUPS.map((group) => [group, days.reduce((sum, day) => sum + day.actions[group], 0)])) as Record<ActionGroup, number>,
    });
  }
  return bars;
}

/** The chart's summary: actions recorded by group, and the day the most people used the app. */
export function activitySummary(series: readonly OverviewDay[], days: number): string {
  const window = `the last ${String(days)} days (UTC)`;
  const total = series.reduce((sum, day) => sum + dayActions(day), 0);
  const busiest = series.reduce<OverviewDay | null>((best, day) => (best === null || day.activePeople > best.activePeople ? day : best), null);
  if (total === 0 && (busiest === null || busiest.activePeople === 0)) return `No one used the app and no actions were recorded in ${window}.`;
  const groups = ACTION_GROUPS.map((group) => `${groupWords(group)} ${formatCount(series.reduce((sum, day) => sum + day.actions[group], 0))}`);
  const actions = `${plural(total, 'action', 'actions')} recorded in ${window}: ${groups.join('; ')}.`;
  if (busiest === null || busiest.activePeople === 0) return `${actions} No one used the app on any day.`;
  return `${actions} The most people who used the app on one day: ${formatCount(busiest.activePeople)}, on ${formatDate(busiest.day)}.`;
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
