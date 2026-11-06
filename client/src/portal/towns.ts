import { fmt0, fmtSigned } from '../marketing/format';
import {
  CAVEATS, countySeries, DATA_YEAR, INDEX_DEFINITION, MONTHS, northeastSeries, SOURCES, type CountySeries, type Source,
} from '../marketing/map/countyData';
import { towns, type Driver, type KeyDate } from '../marketing/map/towns';
import { formatDate, plural } from './format';

// The twelve researched towns for the portal (spec Section 13): the Town select's groups, and the public
// profile shown on Waiting (P4) and the Town tab (P15). It reads the homepage's bundled data modules
// (src/marketing/map/towns.ts and countyData.ts) and never the map geometry, so the portal's bundles stay small.
// patternOf and the labels repeat src/marketing/map/mapState.ts, which imports the geometry; a test keeps
// the two in step.

export { CAVEATS, DATA_YEAR, INDEX_DEFINITION, MONTHS, SOURCES, northeastSeries };
export type { CountySeries, Driver, KeyDate, Source };

export type TownKind = 'college' | 'seasonal' | 'event';
export type Pattern = 'moves' | 'breaks' | 'opposite';

export const KIND_LABEL: Readonly<Record<TownKind, string>> = {
  college: 'College town',
  seasonal: 'Seasonal town',
  event: 'Event town',
};

export const PATTERN_LABEL: Readonly<Record<Pattern, string>> = {
  moves: 'Moves with the region',
  breaks: 'Breaks from the region',
  opposite: 'Runs opposite the region',
};

export const MONTH_NAMES: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
];

/** The API's list for another town (api/src/towns.ts): the 50 states and DC. */
export const US_STATE_CODES: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

/** The Town select's value for “Another town”, which reveals Town name and State. */
export const ANOTHER_TOWN = 'another';

export interface SelectOption { value: string; label: string }
export interface SelectGroup { label: string; options: readonly SelectOption[] }

function option(town: (typeof towns)[number]): SelectOption {
  return { value: town.id, label: `${town.name}, ${town.state}` };
}

/** “College towns” (six), then “Seasonal and event towns” (six), in the homepage's order (shell.md 7.5). */
export const TOWN_GROUPS: readonly SelectGroup[] = [
  { label: 'College towns', options: towns.filter((town) => town.kind === 'college').map(option) },
  { label: 'Seasonal and event towns', options: towns.filter((town) => town.kind !== 'college').map(option) },
];

/** A county breaks from the region at a mean gap of 5 index points or more; opposite when also r <= -0.5. */
export function patternOf(series: CountySeries): Pattern {
  if (series.divergenceVsNortheast < 5) return 'moves';
  return series.correlationWithNortheast <= -0.5 ? 'opposite' : 'breaks';
}

export interface TownProfileData {
  id: string;
  name: string;
  state: string;
  /** "Stowe, VT" */
  label: string;
  kind: TownKind;
  county: string;
  note: string;
  drivers: readonly Driver[];
  dates: readonly KeyDate[];
  series: CountySeries;
  pattern: Pattern;
}

/** One of the twelve, by id; null for another town or an id outside the list. */
export function townProfile(townId: string | null): TownProfileData | null {
  if (townId === null) return null;
  const town = towns.find((candidate) => candidate.id === townId);
  const series = countySeries.find((candidate) => candidate.townId === townId);
  if (town === undefined || series === undefined) return null;
  return {
    id: town.id, name: town.name, state: town.state, label: `${town.name}, ${town.state}`, kind: town.kind,
    county: town.county, note: town.note, drivers: town.drivers, dates: town.dates, series, pattern: patternOf(series),
  };
}

/** The pattern's data sentence: "; biggest gap with the region in May, −15.9 index points." */
export function patternGap(profile: TownProfileData): string {
  const { monthIndex, signedGap } = profile.series.largestGap;
  return `; biggest gap with the region in ${MONTH_NAMES[monthIndex] ?? ''}, ${fmtSigned(signedGap)} index points.`;
}

/**
 * What Townwise has on a town, for the Locations page:
 * "{n} drivers and {m} key dates, from public sources", the drivers-not-researched line, or "Not researched yet".
 */
export function townResearchLine(townId: string | null): string {
  const profile = townProfile(townId);
  if (profile === null) return 'Not researched yet';
  if (profile.drivers.length === 0) return 'Employment pattern only. Drivers aren’t researched yet.';
  const dates = profile.dates.length === 0 ? 'no key dates' : plural(profile.dates.length, 'key date', 'key dates');
  return `${plural(profile.drivers.length, 'driver', 'drivers')} and ${dates}, from public sources`;
}

function busiestAndQuietest(values: readonly number[]): string {
  const busiest = MONTH_NAMES[values.indexOf(Math.max(...values))] ?? '';
  const quietest = MONTH_NAMES[values.indexOf(Math.min(...values))] ?? '';
  return `Busiest month: ${busiest}. Quietest: ${quietest}.`;
}

/** The chart's text summary, from the homepage panel's sentences (TownPanel.web.tsx TownSentences). */
export function townSentences(profile: TownProfileData): string[] {
  const { county, pattern, kind, series } = profile;
  const { index, largestGap } = series;
  const gapMonth = MONTH_NAMES[largestGap.monthIndex] ?? '';
  const swing = fmt0((Math.max(...index) / Math.min(...index) - 1) * 100);
  const lines = [
    busiestAndQuietest(index),
    `Food-service jobs in ${county} swing ${swing}% from the quietest month to the busiest.`,
    `Biggest gap with the region: ${gapMonth}. ${county} sat at ${fmt0(largestGap.countyIndex)}; the Northeast sat at ${fmt0(largestGap.northeastIndex)}.`,
  ];
  if (pattern !== 'moves') lines.push(`A forecast that follows the region’s monthly pattern would miss most in ${gapMonth}.`);
  if (pattern === 'opposite') lines.push(`${county} runs opposite the region: busy when the Northeast is quiet.`);
  if (pattern === 'moves') lines.push(`Month to month, ${county} moves close to the region.`);
  if (pattern === 'moves' && kind === 'college') {
    lines.push('A college calendar acts week by week: finals, Commencement, homecoming. Monthly job counts cannot show a single week, which is why Townwise researches the town’s own calendar.');
  }
  return lines;
}

/** "Sep 14, 2026", or "Nov 22 to Nov 30, 2025" within one year. */
export function dateRange(start: string, end: string | null): string {
  if (end === null) return formatDate(start);
  if (start.slice(0, 4) !== end.slice(0, 4)) return `${formatDate(start)} to ${formatDate(end)}`;
  return `${formatDate(start).replace(/, \d{4}$/, '')} to ${formatDate(end)}`;
}

/** A source's link text: its host for a public institution (.edu, .gov), "Source" otherwise, numbered on repeats. */
export function sourceLinks(urls: readonly string[]): { url: string; text: string }[] {
  const texts = urls.map((url) => {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return /\.(?:edu|gov)$/.test(host) ? host : 'Source';
  });
  return urls.map((url, index) => {
    const text = texts[index] ?? 'Source';
    if (texts.filter((other) => other === text).length < 2) return { url, text };
    return { url, text: `${text} ${String(texts.slice(0, index + 1).filter((other) => other === text).length)}` };
  });
}

/** The gap copy for a town outside the twelve (spec 13). */
export function notResearchedLine(town: { name: string; state: string }): string {
  return `Townwise hasn’t researched ${town.name}, ${town.state} yet. Profiles cover twelve Northeast towns today.`;
}
