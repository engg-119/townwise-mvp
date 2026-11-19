// The checks between the extract's answer and a thread's findings (D66 design decision 5). Pure. Every kept event cites
// at least one source the thread's own messages returned (ledger.ts), has dates that parse inside the window, a title
// that passes the one text check, and a confidence computed here: the model's own rating can only lower it. Anything
// else is dropped and counted by reason; nothing here logs, and a count is all a log line may carry.
//
// The extract's schema is flat, every field required and nullable where it may be empty, with no length limits (the
// suggestions call's pattern): the answer is read leniently, item by item, and every limit is checked here. It asks for
// no guess of an event's effect on guests: weekly suggestions judge that themselves.
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

import type { Ledger, LedgerSource } from './ledger.ts';
import type { ResearchWindow } from './threads.ts';

export const EVENT_KINDS = ['event', 'season', 'closure'] as const;
export const EVENT_CATEGORIES = ['school', 'sports', 'arts', 'festival', 'civic', 'tourism', 'market', 'community', 'dining', 'other'] as const;
export const EVENT_STATUSES = ['scheduled', 'cancelled', 'postponed'] as const;
export const ENTITY_TYPES = ['venue', 'organization', 'team', 'school', 'business'] as const;
export const CONFIDENCES = ['high', 'medium', 'low'] as const;

export type EventKind = typeof EVENT_KINDS[number];
export type EventCategory = typeof EVENT_CATEGORIES[number];
export type EventStatus = typeof EVENT_STATUSES[number];
export type EntityType = typeof ENTITY_TYPES[number];
export type Confidence = typeof CONFIDENCES[number];

export const MAX_EVENTS = 40;
export const MAX_ENTITIES = 30;
export const MAX_TITLE_CHARS = 120;
export const MAX_EVENT_SOURCES = 5;
export const MAX_ENTITY_SOURCES = 3;
/** A start more than this many days outside the window is dropped. */
const WINDOW_SLACK_DAYS = 7;
const MAX_EVENT_DAYS = 30;
/** A season's longest span; a closure (road work, construction) is held to the same. */
const MAX_SEASON_DAYS = 200;
/** A quote with no year is ungrounded when every source is older than this. */
const STALE_MONTHS = 9;

const extractEvent = z.object({
  title: z.string(),
  kind: z.enum(EVENT_KINDS),
  category: z.enum(EVENT_CATEGORIES),
  startDate: z.string(),
  endDate: z.string(),
  weekdays: z.array(z.number().int()).nullable(),
  startTime: z.string().nullable(),
  status: z.enum(EVENT_STATUSES),
  venueRef: z.string().nullable(),
  hostRef: z.string().nullable(),
  competitor: z.number().int().nullable(),
  sourceIds: z.array(z.string()),
  dateQuote: z.string(),
  confidence: z.enum(CONFIDENCES),
});
const extractEntity = z.object({ ref: z.string(), type: z.enum(ENTITY_TYPES), name: z.string(), sourceIds: z.array(z.string()) });
const extractAnswer = z.object({ events: z.array(extractEvent), entities: z.array(extractEntity) });

/** The extract's JSON schema, as betaZodOutputFormat makes it. */
export const EXTRACT_FORMAT = { type: 'json_schema', schema: betaZodOutputFormat(extractAnswer).schema } as const;

// ---- The one text check ----------------------------------------------------------------------------------------------

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const URL_LIKE = /https?:\/\/|\bwww\.|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:com|org|net|edu|gov|io|info|biz|us|co|app|events|live|tickets|me|ly|tv|ca|uk)\b/iu;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

/**
 * The value trimmed, or null when it is empty, longer than `max`, or holds a control or format character, a URL or a
 * web address, an email address or a phone number. Used for extracted titles, entity names and source labels, and for
 * the edits people and TownwiseAI make to researched events.
 */
export function safeText(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return null;
  if (CONTROL_OR_FORMAT.test(trimmed) || URL_LIKE.test(trimmed) || EMAIL.test(trimmed) || PHONE.test(trimmed)) return null;
  return trimmed;
}

// ---- Dates -----------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A YYYY-MM-DD day's time at midnight UTC, or null when it is not a real day. */
function dayMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
}

/**
 * Whether an event's dates are refused (`bad_dates`): a day that does not parse, a start after its end, a start more than
 * 7 days outside the window, an event over 30 days or a season or closure over 200, or a weekday outside its span.
 */
function datesRefused(event: { kind: EventKind; startDate: string; endDate: string; weekdays: number[] | null }, window: ResearchWindow): boolean {
  const start = dayMs(event.startDate);
  const end = dayMs(event.endDate);
  const from = dayMs(window.from);
  const to = dayMs(window.to);
  if (start === null || end === null || from === null || to === null || start > end) return true;
  if (start < from - WINDOW_SLACK_DAYS * DAY_MS || start > to + WINDOW_SLACK_DAYS * DAY_MS) return true;
  const days = (end - start) / DAY_MS + 1;
  if (days > (event.kind === 'event' ? MAX_EVENT_DAYS : MAX_SEASON_DAYS)) return true;
  if (event.weekdays !== null) {
    if (event.weekdays.length === 0 || event.weekdays.some((day) => day < 0 || day > 6)) return true;
    const inSpan = new Set<number>();
    for (let ms = start; ms <= end && inSpan.size < 7; ms += DAY_MS) inSpan.add(new Date(ms).getUTCDay());
    if (event.weekdays.some((day) => !inSpan.has(day))) return true;
  }
  return false;
}

const MONTHS: readonly (readonly string[])[] = [
  ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'], ['may'], ['june', 'jun'], ['july', 'jul'],
  ['august', 'aug'], ['september', 'sept', 'sep'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec'],
];
const WEEKDAY_NAMES: readonly (readonly string[])[] = [
  ['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tues', 'tue'], ['wednesday', 'wed'], ['thursday', 'thurs', 'thur', 'thu'],
  ['friday', 'fri'], ['saturday', 'sat'],
];

function anyOf(names: readonly string[]): string {
  return `(?:${names.join('|')})`;
}

/**
 * Whether the quote states the start date: its month and day ("May 16", "16th of May", "5/16", "2026-05-16"), or, for a
 * recurrence, every one of its weekdays by name ("Wednesdays", "Tue and Thu").
 */
export function mentionsDate(quote: string, startDate: string, weekdays: readonly number[] | null): boolean {
  const lower = quote.toLowerCase();
  const month = Number(startDate.slice(5, 7));
  const day = Number(startDate.slice(8, 10));
  const names = MONTHS[month - 1] ?? [];
  const d = `0?${String(day)}(?:st|nd|rd|th)?`;
  const monthDay = [
    new RegExp(`\\b${anyOf(names)}\\.?\\s+${d}\\b`),
    new RegExp(`\\b${d}\\s+(?:of\\s+)?${anyOf(names)}\\b`),
    new RegExp(`\\b0?${String(month)}/0?${String(day)}\\b`),
  ];
  if (lower.includes(startDate) || monthDay.some((pattern) => pattern.test(lower))) return true;
  if (weekdays === null || weekdays.length === 0) return false;
  return weekdays.every((weekday) => new RegExp(`\\b${anyOf(WEEKDAY_NAMES[weekday] ?? [])}s?\\b`).test(lower));
}

/**
 * The years the quote writes on its start date itself ("May 15, 2025", "15 May 2025", "May 15-17, 2025", "5/15/25"),
 * not a year elsewhere in it ("Class of 2002 reunion, June 12").
 */
function yearsOnDate(quote: string, startDate: string): number[] {
  const month = Number(startDate.slice(5, 7));
  const day = Number(startDate.slice(8, 10));
  const names = anyOf(MONTHS[month - 1] ?? []);
  const d = `0?${String(day)}(?:st|nd|rd|th)?(?:\\s*-\\s*\\d{1,2}(?:st|nd|rd|th)?)?`;
  const year = '((?:19|20)\\d{2})';
  const patterns = [
    new RegExp(`\\b${names}\\.?\\s+${d},?\\s+${year}\\b`, 'g'),
    new RegExp(`\\b${d}\\s+(?:of\\s+)?${names},?\\s+${year}\\b`, 'g'),
    new RegExp(`\\b0?${String(month)}/0?${String(day)}/((?:19|20)?\\d{2})\\b`, 'g'),
  ];
  return patterns.flatMap((pattern) => [...quote.matchAll(pattern)].map((match) => {
    const value = Number(match[1]);
    return value < 100 ? 2000 + value : value;
  }));
}

/** Text as grounding compares it: one form of each character, curly quotes and dashes made plain, spaces collapsed. */
function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ').trim();
}

/** The quote as grounding looks for it: normalized, without the quote marks and punctuation around it. */
function quoteKey(quote: string): string {
  return normalized(quote).replace(/^["'.,;:\s]+|["'.,;:\s]+$/g, '');
}

/** When a search result says its page is from, or null when it does not say in a way this reads. */
export function pageDate(pageAge: string | null, now: Date): Date | null {
  if (pageAge === null) return null;
  const relative = /^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i.exec(pageAge.trim());
  if (relative !== null) {
    const n = Number(relative[1]);
    const at = new Date(now);
    switch ((relative[2] ?? '').toLowerCase()) {
      case 'minute': at.setUTCMinutes(at.getUTCMinutes() - n); break;
      case 'hour': at.setUTCHours(at.getUTCHours() - n); break;
      case 'day': at.setUTCDate(at.getUTCDate() - n); break;
      case 'week': at.setUTCDate(at.getUTCDate() - 7 * n); break;
      case 'month': at.setUTCMonth(at.getUTCMonth() - n); break;
      default: at.setUTCFullYear(at.getUTCFullYear() - n);
    }
    return at;
  }
  const ms = Date.parse(pageAge);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Whether every source is known to be more than STALE_MONTHS old (a source of unknown age is not). */
function allStale(sources: readonly LedgerSource[], now: Date): boolean {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - STALE_MONTHS);
  return sources.length > 0 && sources.every((source) => {
    const at = pageDate(source.pageAge, now);
    return at !== null && at < cutoff;
  });
}

/**
 * Whether the event's date is grounded: its quote, normalized, is in the cited words or fetched text of one of its own
 * sources, it states the start date, a year written on that date is the start's own (last year's "May 15, 2025" never
 * grounds a 2027 date, however recent its page), and it states a year unless at least one source is recent enough.
 */
export function grounded(event: { dateQuote: string; startDate: string; weekdays: readonly number[] | null }, sources: readonly LedgerSource[], now: Date): boolean {
  const key = quoteKey(event.dateQuote);
  if (key === '' || !mentionsDate(key, event.startDate, event.weekdays)) return false;
  const found = sources.some((source) => [...source.quotes, ...(source.fetchedText === null ? [] : [source.fetchedText])]
    .some((textOf) => normalized(textOf).includes(key)));
  if (!found) return false;
  const dated = yearsOnDate(key, event.startDate);
  if (dated.length > 0) return dated.includes(Number(event.startDate.slice(0, 4)));
  return /\b(?:19|20)\d{2}\b/.test(key) || !allStale(sources, now);
}

const RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

/**
 * [CONFIRM: confidence high when a cited quote states the date and 2 sites agree, medium for 1 site, low otherwise]
 */
export function codeConfidence(isGrounded: boolean, sources: readonly LedgerSource[]): Confidence {
  if (!isGrounded) return 'low';
  return new Set(sources.map((source) => source.host)).size >= 2 ? 'high' : 'medium';
}

export function lowerOf(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}

// ---- The answer ------------------------------------------------------------------------------------------------------

export interface SourceRef { readonly label: string; readonly url: string }

export interface FoundEntity {
  /** The answer's own ref, unique within the thread's answer. */
  readonly ref: string;
  readonly type: EntityType;
  readonly name: string;
  readonly sources: readonly SourceRef[];
}

export interface Finding {
  readonly title: string;
  readonly kind: EventKind;
  readonly category: EventCategory;
  readonly start: string;
  readonly end: string;
  /** Sorted, each once; null for every day of the span. */
  readonly weekdays: readonly number[] | null;
  readonly startTime: string | null;
  readonly status: EventStatus;
  /** A kept entity's ref, or null. */
  readonly venueRef: string | null;
  readonly hostRef: string | null;
  /** The competitors list's n, or null. */
  readonly competitor: number | null;
  readonly sources: readonly SourceRef[];
  readonly grounded: boolean;
  /** What code alone says (the merge's status rule reads it). */
  readonly codeConfidence: Confidence;
  /** The lower of code's and the model's: what is stored. */
  readonly confidence: Confidence;
}

export const EVENT_DROP_REASONS = ['bad_shape', 'over_cap', 'no_source', 'unknown_source', 'bad_dates', 'bad_title', 'bad_competitor'] as const;
export const ENTITY_DROP_REASONS = ['bad_shape', 'over_cap', 'bad_ref', 'bad_name', 'no_source'] as const;
export type EventDrops = Record<typeof EVENT_DROP_REASONS[number], number>;
export type EntityDrops = Record<typeof ENTITY_DROP_REASONS[number], number>;

export interface Verified {
  readonly events: Finding[];
  readonly entities: FoundEntity[];
  readonly drops: EventDrops;
  readonly entityDrops: EntityDrops;
}

export interface VerifyContext {
  readonly ledger: Ledger;
  readonly window: ResearchWindow;
  /** The n of each competitor the request listed; empty when it listed none. */
  readonly competitors: readonly number[];
  readonly now: Date;
}

/** A source's label: its page title when that passes the text check, else its host. */
function sourceRef(source: LedgerSource): SourceRef {
  return { label: (source.title === null ? null : safeText(source.title, MAX_TITLE_CHARS)) ?? source.host, url: source.url };
}

/** The distinct ids in order; `unknown` when any is not in the ledger, `none` when there are none. */
function sourcesOf(ids: readonly string[], ledger: Ledger, max: number): LedgerSource[] | 'none' | 'unknown' {
  const distinct = [...new Set(ids.map((id) => id.trim()))];
  if (distinct.length === 0) return 'none';
  const sources = distinct.map((id) => ledger.byId(id));
  if (sources.some((source) => source === undefined)) return 'unknown';
  return (sources as LedgerSource[]).slice(0, max);
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * The thread's findings from the extract's answer, or null when the answer is not the schema's object at all. Entities
 * first, so an event's venue and host refs name only kept entities (an unknown ref is cleared, the event kept).
 */
export function verifyExtract(raw: unknown, context: VerifyContext): Verified | null {
  const top = z.object({ events: z.array(z.unknown()), entities: z.array(z.unknown()) }).safeParse(raw);
  if (!top.success) return null;
  const drops: EventDrops = { bad_shape: 0, over_cap: 0, no_source: 0, unknown_source: 0, bad_dates: 0, bad_title: 0, bad_competitor: 0 };
  const entityDrops: EntityDrops = { bad_shape: 0, over_cap: 0, bad_ref: 0, bad_name: 0, no_source: 0 };

  const entities: FoundEntity[] = [];
  entityDrops.over_cap = Math.max(0, top.data.entities.length - MAX_ENTITIES);
  for (const item of top.data.entities.slice(0, MAX_ENTITIES)) {
    const parsed = extractEntity.safeParse(item);
    if (!parsed.success) { entityDrops.bad_shape += 1; continue; }
    const entity = parsed.data;
    const ref = entity.ref.trim();
    if (ref === '' || entities.some((kept) => kept.ref === ref)) { entityDrops.bad_ref += 1; continue; }
    const name = safeText(entity.name, MAX_TITLE_CHARS);
    if (name === null) { entityDrops.bad_name += 1; continue; }
    const known = entity.sourceIds.flatMap((id) => context.ledger.byId(id.trim()) ?? []);
    if (known.length === 0) { entityDrops.no_source += 1; continue; }
    entities.push({ ref, type: entity.type, name, sources: [...new Set(known)].slice(0, MAX_ENTITY_SOURCES).map(sourceRef) });
  }
  const refs = new Set(entities.map((entity) => entity.ref));
  const keptRef = (ref: string | null): string | null => (ref !== null && refs.has(ref.trim()) ? ref.trim() : null);

  const events: Finding[] = [];
  drops.over_cap = Math.max(0, top.data.events.length - MAX_EVENTS);
  for (const item of top.data.events.slice(0, MAX_EVENTS)) {
    const parsed = extractEvent.safeParse(item);
    if (!parsed.success) { drops.bad_shape += 1; continue; }
    const event = parsed.data;
    const sources = sourcesOf(event.sourceIds, context.ledger, MAX_EVENT_SOURCES);
    if (sources === 'none') { drops.no_source += 1; continue; }
    if (sources === 'unknown') { drops.unknown_source += 1; continue; }
    const weekdays = event.weekdays === null ? null : [...new Set(event.weekdays)].sort((a, b) => a - b);
    if (datesRefused({ ...event, weekdays }, context.window)) { drops.bad_dates += 1; continue; }
    const title = safeText(event.title, MAX_TITLE_CHARS);
    if (title === null) { drops.bad_title += 1; continue; }
    if (event.competitor !== null && !context.competitors.includes(event.competitor)) { drops.bad_competitor += 1; continue; }
    const isGrounded = grounded({ ...event, weekdays }, sources, context.now);
    const fromCode = codeConfidence(isGrounded, sources);
    events.push({
      title, kind: event.kind, category: event.category, start: event.startDate, end: event.endDate, weekdays,
      startTime: event.startTime !== null && TIME.test(event.startTime) ? event.startTime : null,
      status: event.status, venueRef: keptRef(event.venueRef), hostRef: keptRef(event.hostRef), competitor: event.competitor,
      sources: sources.map(sourceRef), grounded: isGrounded, codeConfidence: fromCode, confidence: lowerOf(fromCode, event.confidence),
    });
  }
  return { events, entities, drops, entityDrops };
}
