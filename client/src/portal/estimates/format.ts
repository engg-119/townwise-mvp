import { formatCount, formatDate } from '../format';
import type { PeopleInTown, PeoplePeriod, TermState, Weekday, YourHistory } from './api';

// The estimate sentences (spec 13.2, docs/portal/estimates.md): ranges, term periods, headcount lines, the history line
// and the provenance hosts. Deterministic and never model-written; Home, Analytics and TownwiseAI's cards show these
// beside a figure. Every number is a range or a count of days, never one falsely exact estimate.

const WEEKDAY_PLURAL: Record<Weekday, string> = {
  Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays',
};

/** "180 to 260 guests": the low end rounded down, the high end up. */
export function rangeText(low: number, high: number, noun = 'guests'): string {
  return `${formatCount(Math.floor(low))} to ${formatCount(Math.ceil(high))}${noun === '' ? '' : ` ${noun}`}`;
}

/** "Tue, Nov 17". */
export function dayText(date: string, weekday: Weekday): string {
  return `${weekday}, ${formatDate(date).replace(/, \d{4}$/, '')}`;
}

/** One recorded reason of a forecast day: its label, and its effect only where the run recorded one. */
export interface Reason { label: string; effectPct: number | null }

/** "Saturday, fall term, Football vs Brown (+12%)." */
export function reasonLine(reasons: readonly Reason[]): string {
  if (reasons.length === 0) return '';
  const parts = reasons.map((reason) => {
    if (reason.effectPct === null) return reason.label;
    const sign = reason.effectPct > 0 ? '+' : reason.effectPct < 0 ? '−' : '';
    return `${reason.label} (${sign}${formatCount(Math.abs(reason.effectPct))}%)`;
  });
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

const BETWEEN_TERMS_NOTE = 'Between terms is worked out from the term dates.';

interface TermSpan { state: TermState; label: string | null; from: string; fromWeekday: Weekday; to: string; toWeekday: Weekday }

/** The window's periods with events folded away: one span per run of the same term state. */
export function termSpans(periods: readonly PeoplePeriod[]): TermSpan[] {
  const spans: TermSpan[] = [];
  for (const period of periods) {
    const last = spans.at(-1);
    if (last?.state === period.termState && last.label === period.termLabel) {
      last.to = period.to;
      last.toWeekday = period.toWeekday;
    } else {
      spans.push({
        state: period.termState, label: period.termLabel, from: period.from, fromWeekday: period.fromWeekday, to: period.to,
        toWeekday: period.toWeekday,
      });
    }
  }
  return spans;
}

function spanText(span: TermSpan, window: { from: string; to: string }): string {
  const from = dayText(span.from, span.fromWeekday);
  const to = dayText(span.to, span.toWeekday);
  if (span.from === span.to) return `on ${from}`;
  if (span.from === window.from && span.to !== window.to) return `until ${to}`;
  if (span.from !== window.from && span.to === window.to) return `from ${from}`;
  return `${from} to ${to}`;
}

/**
 * The term in words: "Fall term classes until Tue, Nov 17. Fall term finals Fri, Nov 20 to Wed, Nov 25. Between terms
 * from Thu, Nov 26." Days without term dates say so. Empty for a town that is not a college town and has none.
 */
export function termLines(window: Pick<PeopleInTown, 'from' | 'to' | 'periods' | 'town'>): string[] {
  const spans = termSpans(window.periods);
  if (window.town.kind !== 'college' && spans.every((span) => span.state === 'unknown')) return [];
  const lines = spans.map((span) => {
    const when = spanText(span, window);
    if (span.state === 'unknown') return `Townwise has no term dates ${when}.`;
    if (span.state === 'between_terms') return `Between terms ${when}.`;
    return `${span.label ?? 'Term'} ${when}.`;
  });
  if (spans.some((span) => span.state === 'between_terms')) lines.push(BETWEEN_TERMS_NOTE);
  return lines;
}

export function noNumberLine(town: { name: string }): string {
  return `Townwise can’t put a number on how many people are in ${town.name} yet.`;
}

/** "Fall term classes. About 9,500 to 10,500 people in town, from 3 sources." */
export function peopleLine(period: PeoplePeriod, town: { name: string }): string {
  const lead = period.termState === 'between_terms' ? 'Between terms.' : period.termLabel === null ? '' : `${period.termLabel}.`;
  const count = period.headcount === null
    ? noNumberLine(town)
    : `About ${rangeText(period.headcount.low, period.headcount.high, 'people')} in town, from ${formatCount(period.headcount.sourceIds.length)} ${period.headcount.sourceIds.length === 1 ? 'source' : 'sources'}.`;
  return lead === '' ? count : `${lead} ${count}`;
}

/**
 * When any day has a range, the term lines with it: one line per run of days with the same term and the same range,
 * "Fall term classes until Tue, Nov 17. About 9,500 to 10,500 people in town, from 1 source." Days without a range
 * say so, with the reason when it is missing term dates. Empty when no day has a range (the caller then shows the
 * term lines and the "can't put a number on it" line once).
 */
export function headcountLines(window: Pick<PeopleInTown, 'from' | 'to' | 'periods' | 'town'>): string[] {
  if (window.periods.every((period) => period.headcount === null)) return [];
  const runs: { first: PeoplePeriod; span: TermSpan }[] = [];
  const key = (period: PeoplePeriod): string => JSON.stringify([
    period.termState, period.termLabel, period.headcount?.low ?? null, period.headcount?.high ?? null,
  ]);
  for (const period of window.periods) {
    const last = runs.at(-1);
    if (last !== undefined && key(last.first) === key(period)) {
      last.span.to = period.to;
      last.span.toWeekday = period.toWeekday;
    } else {
      runs.push({ first: period, span: { state: period.termState, label: period.termLabel, from: period.from, fromWeekday: period.fromWeekday, to: period.to, toWeekday: period.toWeekday } });
    }
  }
  const lines = runs.map(({ first, span }) => {
    const when = spanText(span, window);
    const { headcount } = first;
    if (headcount === null && span.state === 'unknown') return `Townwise has no term dates ${when}, so it can’t put a number on how many people are in town.`;
    if (headcount === null) return `Townwise can’t put a number on how many people are in ${window.town.name}, ${when}.`;
    const lead = span.state === 'between_terms' ? 'Between terms' : span.label ?? 'These days';
    const sources = headcount.sourceIds.length;
    return `${lead} ${when}. About ${rangeText(headcount.low, headcount.high, 'people')} in town, from ${formatCount(sources)} ${sources === 1 ? 'source' : 'sources'}.`;
  });
  if (runs.some(({ span }) => span.state === 'between_terms')) lines.push(BETWEEN_TERMS_NOTE);
  return lines;
}

function amount(mean: number, metric: YourHistory['metric']): string {
  return metric === 'guests' ? `${formatCount(mean)} guests` : `$${formatCount(mean)} in net sales`;
}

/**
 * "Your Saturdays averaged 250 guests in term and 140 between terms (18 and 6 Saturdays).", for the weekday with the
 * most days that has a mean both in session and between terms; null when no weekday has both.
 */
export function historyLine(history: YourHistory): string | null {
  const cell = (state: TermState, weekday: Weekday) => history.cells.find((each) => each.state === state && each.weekday === weekday);
  let best: { weekday: Weekday; inTerm: { days: number; mean: number }; between: { days: number; mean: number } } | null = null;
  for (const weekday of Object.keys(WEEKDAY_PLURAL) as Weekday[]) {
    const inTerm = cell('in_session', weekday);
    const between = cell('between_terms', weekday);
    if (inTerm?.mean == null || between?.mean == null) continue;
    const pair = { weekday, inTerm: { days: inTerm.days, mean: inTerm.mean }, between: { days: between.days, mean: between.mean } };
    if (best === null || pair.inTerm.days + pair.between.days > best.inTerm.days + best.between.days) best = pair;
  }
  if (best === null) return null;
  const name = WEEKDAY_PLURAL[best.weekday];
  const second = history.metric === 'guests' ? formatCount(best.between.mean) : `$${formatCount(best.between.mean)}`;
  return `Your ${name} averaged ${amount(best.inTerm.mean, history.metric)} in term and ${second} between terms (${formatCount(best.inTerm.days)} and ${formatCount(best.between.days)} ${name}).`;
}

/**
 * The distinct https hosts of the window's sources, in order, each with its first link. Read with a pattern rather
 * than URL, whose host getters are not on every native runtime.
 */
export function sourceHosts(sources: readonly { url: string }[]): { host: string; url: string }[] {
  const seen = new Map<string, string>();
  for (const { url } of sources) {
    const match = /^https:\/\/(?:www\.)?([^/?#:@]+)(?:[/?#]|$)/i.exec(url);
    const host = match?.[1]?.toLowerCase();
    if (host !== undefined && !seen.has(host)) seen.set(host, url);
  }
  return [...seen].map(([host, url]) => ({ host, url }));
}
