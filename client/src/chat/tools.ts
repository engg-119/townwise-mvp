import type { ToolView } from './api';
import { dayText, formatCount, rangeText } from './format';

// The client's tool table (spec P25): what each TownwiseAI tool call's card says while it runs, once it has read,
// and when it couldn't, the detail line from its result view, and its piece of the "Based on" line. The words are
// built here from the call's views (dates, counts and source links), never written by the model. A tool this table
// doesn't know (one the server added before its row landed here) still gets a card, in general words.
//
// The registry on the server is append-only (api/src/chat/tools/registry.ts); a PR that appends a tool appends its
// row here too, and test/chat/tools.test.ts lists the names as api/test/chat-tools.test.ts does.

export interface ToolStep {
  /** The tool_use block's id. */
  id: string;
  name: string;
  state: 'running' | 'done' | 'error';
  input: ToolView | null;
  result: ToolView | null;
}

/**
 * What the copy may name: the location's town ("Hanover"), whether Townwise has researched its town profile, and
 * (F10) whether GET .../estimates/about says a forecast is published for the location. `hasForecast` is true only once
 * that read says so; absent or false, nothing claims a forecast.
 */
export interface ToolContext { town: string; hasTownProfile: boolean; hasForecast?: boolean }

export interface SourceLink { host: string; url: string }

interface ToolRow {
  /** The thing read, after the status word: "your notes", "Hanover’s town profile". */
  object(input: ToolView | null, ctx: ToolContext, result: ToolView | null): string;
  detail?(result: ToolView, input: ToolView | null, ctx: ToolContext): string | null;
  sources?(result: ToolView): SourceLink[];
  /** Its piece of the Based on line; the object when absent. */
  basedOn?(input: ToolView | null, ctx: ToolContext, result: ToolView | null): string;
  /**
   * What TownwiseAI reads, for the composer's help line and How TownwiseAI works. Only for tools the server has
   * registered: a row added ahead of its tool leaves it out, so the page never claims a source it can't read. Null
   * when this location has nothing for it to read.
   */
  reads?(ctx: ToolContext): string | null;
  /** Its `reads` needs the location's sales: left out of what TownwiseAI can use before any are uploaded. */
  needsSales?: true;
  /** Not a card: propose_note shows the proposal card instead. */
  hidden?: true;
  /** Words for this tool's view fields where the shared VIEW_TERMS would mislabel them. */
  terms?: Readonly<Record<string, string>>;
}

function text(view: ToolView | null, key: string): string | null {
  const value = view?.[key];
  return typeof value === 'string' ? value : null;
}

function count(view: ToolView | null, key: string): number | null {
  const value = view?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function plural(value: number, one: string, many: string): string {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}

function rangeOf(view: ToolView | null): string | null {
  const from = text(view, 'from');
  const to = text(view, 'to');
  return from === null || to === null ? null : rangeText(from, to);
}

/** The https links of a view's `sources`, at most 5, as the server lists them. */
function sourcesOf(result: ToolView): SourceLink[] {
  const sources = result.sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source: unknown) => {
    if (typeof source !== 'object' || source === null) return [];
    const { host, url } = source as { host?: unknown; url?: unknown };
    return typeof host === 'string' && typeof url === 'string' && url.startsWith('https://') ? [{ host, url }] : [];
  }).slice(0, 5);
}

function hostsOf(result: ToolView | null): string {
  return result === null ? '' : sourcesOf(result).map((source) => source.host).join(', ');
}

/** "Hanover", from a view's `town` (a name, or `{ name }`), else the location's town. */
function townOf(result: ToolView | null, ctx: ToolContext): string {
  const town = result?.town;
  if (typeof town === 'string' && town !== '') return town;
  if (typeof town === 'object' && town !== null && typeof (town as { name?: unknown }).name === 'string') return (town as { name: string }).name;
  return ctx.town;
}

function possessive(name: string): string {
  return `${name}’s`;
}

const TOOLS: Readonly<Record<string, ToolRow>> = {
  get_location_overview: {
    object: () => 'your sales summary',
    detail: (result) => {
      const days = count(result, 'dayCount');
      const first = text(result, 'firstDate');
      const last = text(result, 'lastDate');
      if (days === null || days === 0 || first === null || last === null) return 'No sales uploaded yet';
      const missing = count(result, 'missingDays') ?? 0;
      const span = `${plural(days, 'day', 'days')}, ${rangeText(first, last)}`;
      return missing === 0 ? span : `${span}, ${plural(missing, 'day', 'days')} missing`;
    },
    basedOn: (_input, _ctx, result) => {
      const first = text(result, 'firstDate');
      const last = text(result, 'lastDate');
      return first === null || last === null ? 'your sales summary' : `your sales summary (${rangeText(first, last)})`;
    },
    reads: () => 'your sales',
    needsSales: true,
  },
  get_sales_days: {
    object: (input) => {
      const range = rangeOf(input);
      return range === null ? 'your sales' : `your sales for ${range}`;
    },
    detail: (result) => {
      const days = count(result, 'dayCount');
      if (days === null) return null;
      if (days === 0) return 'No sales in this range';
      return `${plural(days, 'day', 'days')}: guests on ${formatCount(count(result, 'guestsDayCount') ?? 0)}, net sales on ${formatCount(count(result, 'netSalesDayCount') ?? 0)}`;
    },
    basedOn: (input) => {
      const range = rangeOf(input);
      return range === null ? 'your sales' : `your sales from ${range}`;
    },
    reads: () => 'your sales',
    needsSales: true,
  },
  list_notes: {
    object: () => 'your notes',
    detail: (result) => {
      const notes = count(result, 'count');
      if (notes === null) return null;
      return notes === 0 ? 'No notes yet' : plural(notes, 'note', 'notes');
    },
    basedOn: (_input, _ctx, result) => {
      const notes = count(result, 'count');
      if (notes === null) return 'your notes';
      return notes === 0 ? 'your notes (none yet)' : `your ${plural(notes, 'note', 'notes')}`;
    },
    reads: () => 'your notes',
  },
  get_town_profile: {
    object: (_input, ctx, result) => `${possessive(townOf(result, ctx))} town profile`,
    detail: (result) => {
      if (result.available === false) return 'Townwise hasn’t researched this town yet';
      const hosts = sourcesOf(result).map((source) => source.host);
      return hosts.length === 0 ? null : hosts.join(' · ');
    },
    sources: sourcesOf,
    basedOn: (_input, ctx, result) => {
      const hosts = hostsOf(result);
      const name = `${possessive(townOf(result, ctx))} town profile`;
      return hosts === '' ? name : `${name} (${hosts})`;
    },
    reads: (ctx) => (ctx.hasTownProfile ? `${possessive(ctx.town)} town profile` : null),
  },
  propose_note: {
    object: () => 'a note for you to check',
    hidden: true,
  },
  // U13A: get_town_calendar and get_people_in_town (api/src/chat/tools/town-calendar.ts, people-in-town.ts).
  get_town_calendar: {
    object: (input, ctx, result) => {
      const range = rangeOf(input);
      const name = `${possessive(townOf(result, ctx))} calendar`;
      return range === null ? name : `${name} for ${range}`;
    },
    detail: (result, _input, ctx) => {
      const events = count(result, 'eventCount');
      // An unresearched town's calendar still has the US federal holidays (spec 13.1).
      const lead = result.researched === false
        ? `Holidays only; ${townOf(result, ctx)} isn’t researched yet`
        : events === null ? null : events === 0 ? 'No events in this range' : plural(events, 'event', 'events');
      const hosts = sourcesOf(result).map((source) => source.host);
      const line = [lead, ...hosts].filter((part): part is string => part !== null).join(' · ');
      return line === '' ? null : line;
    },
    sources: sourcesOf,
    // Every town has one: the federal holidays, with researched events where Townwise has them.
    reads: () => 'the town calendar',
  },
  get_people_in_town: {
    object: (input, ctx, result) => {
      const range = rangeOf(input);
      const who = `who’s in ${townOf(result, ctx)}`;
      return range === null ? who : `${who} for ${range}`;
    },
    detail: (result) => {
      if (result.available === false) return 'Townwise hasn’t researched who’s in this town yet';
      const sources = sourcesOf(result);
      const headcount = result.headcount === 'range'
        ? `Headcount range from ${plural(sources.length, 'source', 'sources')}`
        : 'No headcount yet';
      return [headcount, ...sources.map((source) => source.host)].join(' · ');
    },
    sources: sourcesOf,
    // Only the twelve towns have term dates and public counts; another town's window is unavailable.
    reads: (ctx) => (ctx.hasTownProfile ? `who’s likely in ${ctx.town}` : null),
  },
  // U13B: get_forecast (api/src/chat/tools/forecast.ts). Published runs only. Its `reads` line shows only once the
  // page has read from GET .../estimates/about that a run is published (F10), so the page never claims one that isn't.
  get_forecast: {
    // "Reading Townwise’s forecast for …" while it runs, "Read the forecast for …" once it has (model.md 5.6).
    object: (input, _ctx, result) => {
      const range = rangeOf(input);
      const name = result === null ? 'Townwise’s forecast' : 'the forecast';
      return range === null ? name : `${name} for ${range}`;
    },
    detail: (result) => {
      if (result.available === false) return 'No forecast yet';
      const version = text(result, 'modelVersion');
      const madeAt = text(result, 'madeAt');
      return version === null || madeAt === null ? null : `Model ${version}, made ${rangeText(madeAt, madeAt)}`;
    },
    basedOn: (input, _ctx, result) => {
      const range = rangeOf(input);
      const name = range === null ? 'Townwise’s forecast' : `Townwise’s forecast for ${range}`;
      if (result?.available === false) return `${name} (none yet)`;
      const version = text(result, 'modelVersion');
      return version === null ? name : `${name} (model ${version})`;
    },
    terms: { available: 'Forecast published', days: 'Days forecast' },
    reads: (ctx) => (ctx.hasForecast === true ? 'Townwise’s forecast' : null),
  },
  // F2: get_day (api/src/chat/tools/day.ts). Everything Townwise has for one day: sales, notes and calendar entries
  // that the other rows' `reads` already name, so it adds no line of its own.
  get_day: {
    object: (input) => {
      const date = text(input, 'date');
      return date === null ? 'what Townwise has for a day' : `what Townwise has for ${dayText(date)}`;
    },
    detail: (result) => {
      const notes = count(result, 'noteCount');
      const events = count(result, 'eventCount');
      const parts = [
        result.hasSales === true ? 'Sales recorded' : 'No sales recorded',
        result.closed === true ? 'Closed' : null,
        notes === null || notes === 0 ? null : plural(notes, 'note', 'notes'),
        events === null || events === 0 ? null : plural(events, 'calendar entry', 'calendar entries'),
        ...sourcesOf(result).map((source) => source.host),
      ];
      return parts.filter((part): part is string => part !== null).join(' · ');
    },
    sources: sourcesOf,
    terms: { date: 'Day', hasSales: 'Sales recorded', closed: 'Closed', noteCount: 'Notes', eventCount: 'Calendar entries' },
  },
};

const GENERIC = { running: 'Looking something up', done: 'Looked something up', error: 'Couldn’t look something up' } as const;

export function isKnownTool(name: string): boolean {
  return Object.hasOwn(TOOLS, name);
}

/** propose_note's calls show as the proposal card, not a tool card. */
export function isHiddenTool(name: string): boolean {
  return TOOLS[name]?.hidden === true;
}

export interface ToolLine {
  /** "Reading", "Read" or "Couldn’t read"; empty for a tool this table doesn't know. */
  status: string;
  /** The rest of the sentence: "your sales for Oct 1 to Oct 31, 2026". */
  object: string;
  /** The whole sentence, for the live region and the row's accessible name. */
  sentence: string;
  detail: string | null;
  sources: SourceLink[];
}

/** A card's words for a call in its current state. */
export function toolLine(step: ToolStep, ctx: ToolContext): ToolLine {
  const row = Object.hasOwn(TOOLS, step.name) ? TOOLS[step.name] : undefined;
  if (row === undefined) {
    const sentence = GENERIC[step.state];
    return { status: '', object: sentence, sentence, detail: null, sources: [] };
  }
  const status = step.state === 'running' ? 'Reading' : step.state === 'done' ? 'Read' : 'Couldn’t read';
  const object = row.object(step.input, ctx, step.result);
  const done = step.state === 'done' && step.result !== null;
  return {
    status,
    object,
    sentence: `${status} ${object}`,
    detail: done && row.detail !== undefined && step.result !== null ? row.detail(step.result, step.input, ctx) : null,
    sources: done && row.sources !== undefined && step.result !== null ? row.sources(step.result) : [],
  };
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0] ?? ''} and ${items[1] ?? ''}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1) ?? ''}`;
}

/**
 * The line under a finished reply, built only from the calls that read something: "Based on your sales from Oct 1
 * to Oct 31, 2026, your 12 notes, and Hanover’s town profile (bls.gov, dartmouth.edu)." A call that failed read
 * nothing and is left out; a reply with no reads is "Based on this conversation only."
 */
export function basedOnLine(steps: readonly ToolStep[], ctx: ToolContext): string {
  const pieces: string[] = [];
  for (const step of steps) {
    if (step.state !== 'done' || isHiddenTool(step.name)) continue;
    const row = Object.hasOwn(TOOLS, step.name) ? TOOLS[step.name] : undefined;
    const piece = row === undefined
      ? 'something else TownwiseAI looked up'
      : (row.basedOn ?? row.object)(step.input, ctx, step.result);
    if (!pieces.includes(piece)) pieces.push(piece);
  }
  return pieces.length === 0 ? 'Based on this conversation only.' : `Based on ${list(pieces)}.`;
}

/**
 * What TownwiseAI reads, from the registered tools: "your sales, your notes and Hanover’s town profile". With
 * `sales: false`, what it can use before any sales are uploaded.
 */
export function readsLine(ctx: ToolContext, opts: { sales?: boolean } = {}): string {
  const reads: string[] = [];
  for (const row of Object.values(TOOLS)) {
    if (opts.sales === false && row.needsSales === true) continue;
    const read = row.reads?.(ctx);
    if (read !== undefined && read !== null && !reads.includes(read)) reads.push(read);
  }
  if (reads.length <= 1) return reads[0] ?? '';
  return `${reads.slice(0, -1).join(', ')} and ${reads.at(-1) ?? ''}`;
}

/** The words for a view's fields, in the order they come. Only dates, counts, yes or no, and a town's name. */
const VIEW_TERMS: Readonly<Record<string, string>> = {
  from: 'From', to: 'To', firstDate: 'First day', lastDate: 'Last day', dayCount: 'Days', missingDays: 'Days missing',
  monthCount: 'Months', guestsDayCount: 'Days with guests', netSalesDayCount: 'Days with net sales', count: 'Notes',
  available: 'Researched', researched: 'Researched', town: 'Town', eventCount: 'Events', periods: 'Periods', headcount: 'Headcount',
  modelVersion: 'Model', madeAt: 'Made', dataThrough: 'Sales through', notCovered: 'Days not covered',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function valueText(key: string, value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return formatCount(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') {
    if (DATE.test(value)) return rangeText(value, value);
    if (key === 'headcount') return value === 'range' ? 'A range, with sources' : 'None yet';
    return value;
  }
  if (key === 'town' && typeof value === 'object' && value !== null) {
    const { name, state } = value as { name?: unknown; state?: unknown };
    if (typeof name === 'string') return typeof state === 'string' ? `${name}, ${state}` : name;
  }
  return null;
}

/**
 * An opened card's rows: the input view, then the result view, field by field, in words. Fields this table has no
 * words for are left out, and so are sources (shown as links) and anything that is not a date, a count, yes or no.
 * `name` lets a tool's own words replace the shared ones (get_forecast's `available` is not "Researched").
 */
export function viewRows(input: ToolView | null, result: ToolView | null, name?: string): { term: string; value: string }[] {
  const own = name !== undefined && Object.hasOwn(TOOLS, name) ? TOOLS[name]?.terms : undefined;
  const rows: { term: string; value: string }[] = [];
  for (const view of [input, result]) {
    if (view === null) continue;
    for (const [key, value] of Object.entries(view)) {
      const term = own !== undefined && Object.hasOwn(own, key) ? own[key] : Object.hasOwn(VIEW_TERMS, key) ? VIEW_TERMS[key] : undefined;
      const shown = term === undefined ? null : valueText(key, value);
      if (term !== undefined && shown !== null && !rows.some((row) => row.term === term)) rows.push({ term, value: shown });
    }
  }
  return rows;
}
