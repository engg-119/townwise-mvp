// When two researched happenings are the same one, and when two names are the same entity (D66 design decision 8).
// Pure. Titles compare as word sets (Jaccard), with case, accents, possessives and small words set aside; names compare
// by one key (NFKD, lowercase, a leading "the" and company suffixes such as "Inc" dropped), which is also the stored
// entity's unique key, so "The Hopkins Center" and "Hopkins Center" are one venue.

/** Words a title's meaning does not rest on. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);
/** A business name's legal suffixes. */
const SUFFIXES = new Set(['co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'limited', 'llc', 'ltd', 'plc']);

const DAY_MS = 86_400_000;

/** Lowercase words, accents and possessives removed, `&` read as "and". */
function words(value: string): string[] {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['’]s\b/g, '').replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
}

/** A title's words that carry its meaning. */
export function titleTokens(title: string): Set<string> {
  return new Set(words(title).filter((word) => !SMALL_WORDS.has(word)));
}

/** A title as stored for matching (`titleKey`): its meaningful words in order, once each. */
export function titleKey(title: string): string {
  return [...titleTokens(title)].join(' ');
}

/** Shared words over all words; 0 when both are empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** An entity's name as its unique key: no leading "the", no trailing company suffixes. Empty when nothing is left. */
export function nameKey(name: string): string {
  const parts = words(name);
  if (parts[0] === 'the' && parts.length > 1) parts.shift();
  while (parts.length > 1 && SUFFIXES.has(parts.at(-1) ?? '')) parts.pop();
  return parts.join(' ');
}

/** Below this many characters, a name key is too short to stand for a business by its first words alone ("inn", "pizza"). */
const MIN_PREFIX_CHARS = 6;

/**
 * Whether two name keys name the same business: equal, or the shorter is the longer's first whole words and at least 6
 * characters, so "Sawtooth" and "Sawtooth Kitchen, Bar and Stage" are one restaurant.
 */
export function sameBusiness(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= MIN_PREFIX_CHARS && long.startsWith(`${short} `);
}

export interface DayRange { readonly start: string; readonly end: string }

export function overlaps(a: DayRange, b: DayRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function startsWithinADay(a: DayRange, b: DayRange): boolean {
  return Math.abs(Date.parse(`${a.start}T00:00:00Z`) - Date.parse(`${b.start}T00:00:00Z`)) <= DAY_MS;
}

/** What two happenings are compared by. A curated row has no category or venue. */
export interface Comparable extends DayRange {
  readonly title: string;
  readonly category: string | null;
  /** The venue entity's nameKey, or null. */
  readonly venueKey: string | null;
}

/**
 * The same happening, for dedupe across a run's threads and against curated and town rows: starts within a day of each
 * other or overlapping ranges, with titles at least half the same words; or the same venue, start and category.
 */
export function sameEvent(a: Comparable, b: Comparable): boolean {
  if ((startsWithinADay(a, b) || overlaps(a, b)) && jaccard(titleTokens(a.title), titleTokens(b.title)) >= 0.5) return true;
  return a.venueKey !== null && a.venueKey === b.venueKey && a.start === b.start && a.category !== null && a.category === b.category;
}

/** How closely a finding matches a stored row of its subject: the title Jaccard when the dates overlap and it reaches 0.6, else 0. */
export function storedMatch(finding: Comparable, row: Comparable): number {
  if (!overlaps(finding, row)) return 0;
  const score = jaccard(titleTokens(finding.title), titleTokens(row.title));
  return score >= 0.6 ? score : 0;
}
