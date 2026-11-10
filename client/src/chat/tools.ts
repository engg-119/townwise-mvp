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
 * that read says so; absent or false, nothing claims a forecast. `hasSales` false (the location has no sales days yet)
 * leaves the sales out of every line built from the table, so no line claims TownwiseAI answers from them.
 */
export interface ToolContext { town: string; hasTownProfile: boolean; hasForecast?: boolean; hasSales?: boolean }

export interface SourceLink { host: string; url: string }

interface ToolRow {
  /** The thing read, after the status word: "your notes", "Hanover’s town profile". */
  object(input: ToolView | null, ctx: ToolContext, result: ToolView | null): string;
  /** The status word for a tool that does something rather than read: "Starting", not "Reading". */
  status?(state: ToolStep['state'], result: ToolView | null): string;
  detail?(result: ToolView, input: ToolView | null, ctx: ToolContext): string | null;
  sources?(result: ToolView): SourceLink[];
  /** Its piece of the Based on line; the object when absent, and null for a call that read nothing. */
  basedOn?(input: ToolView | null, ctx: ToolContext, result: ToolView | null): string | null;
  /**
   * What TownwiseAI reads, for the composer's help line and How TownwiseAI works. Only for tools the server has
   * registered: a row added ahead of its tool leaves it out, so the page never claims a source it can't read. Null
   * when this location has nothing for it to read.
   */
  reads?(ctx: ToolContext): string | null;
  /** Its `reads` needs the location's sales: left out of what TownwiseAI can use before any are uploaded. */
  needsSales?: true;
  /** Not a card: propose_note shows the proposal card, propose_data_item its item card, show_visual its visual and suggest_next its next questions instead. */
  hidden?: true;
  /** Words for this tool's view fields where the shared VIEW_TERMS would mislabel them. */
  terms?: Readonly<Record<string, string>>;
  /** Words for the codes a view field carries; a code with no words here is left out of the opened card. */
  values?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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

/** A calibration's status (api/src/stores/calibrations.ts), in words. */
const CALIBRATION_STATUS: Readonly<Record<string, string>> = {
  queued: 'Waiting to start', running: 'Running', succeeded: 'Finished', failed: 'Didn’t finish',
};

/** Why start_calibration didn't start one (api/src/lab/service.ts START_REFUSAL_WORDS, shortened), in words. */
const START_REFUSAL: Readonly<Record<string, string>> = {
  org_admin_only: 'Only an org admin can calibrate',
  lab_unavailable: 'Calibration isn’t available right now',
  not_enough_history: 'Not enough sales history yet',
  invalid_regime_start: 'The pattern change date doesn’t fit the sales history',
  budget_exhausted: 'This month’s TownwiseAI budget is used up',
  in_progress: 'One is already running for this location',
  rate_limited: 'Today’s calibrations are used up',
  start_failed: 'It couldn’t start',
};

function wordsFor(words: Readonly<Record<string, string>>, code: string | null): string | null {
  return code !== null && Object.hasOwn(words, code) ? words[code] ?? null : null;
}

/**
 * A lab read's card line: nothing to show, a calibration that is waiting, running or didn't finish, or the weeks it
 * was judged on and whether Townwise published it.
 */
function labDetail(result: ToolView): string | null {
  if (result.available !== true) return 'Nothing to show yet';
  const status = text(result, 'status');
  if (status === 'running') return 'Still running';
  if (status !== null && status !== 'succeeded') return wordsFor(CALIBRATION_STATUS, status);
  const weeks = count(result, 'weeks');
  const judged = weeks === null ? null : plural(weeks, 'held-out week', 'held-out weeks');
  const published = result.published === true ? 'Published' : result.published === false ? 'Not published' : null;
  const line = [judged, published].filter((part): part is string => part !== null).join(' · ');
  return line === '' ? null : line;
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
  // The chat redesign's show_visual and suggest_next (api/src/chat/tools/visual.ts, next.ts; tuning-chat.md 4): their
  // views are null, and a reply shows the visual and the three next questions their own events carry.
  show_visual: {
    object: () => 'the figures for a chart',
    hidden: true,
  },
  suggest_next: {
    object: () => 'questions to ask next',
    hidden: true,
  },
  // Your data: list_data_items and read_data_item (api/src/chat/tools/list-data.ts, read-data.ts).
  list_data_items: {
    object: () => 'what your team added',
    detail: (result) => {
      const items = count(result, 'count');
      if (items === null) return null;
      return items === 0 ? 'Nothing added yet' : `${plural(items, 'item', 'items')}, ${formatCount(count(result, 'turnedOff') ?? 0)} turned off`;
    },
    terms: { count: 'Items', turnedOff: 'Turned off' },
    reads: () => 'what your team added on Your data',
  },
  read_data_item: {
    object: () => 'an item your team added',
    detail: (result) => {
      if (result.available === false) return 'Couldn’t read it';
      const chars = count(result, 'chars');
      if (chars === null) return null;
      const read = plural(chars, 'character', 'characters');
      return result.truncated === true ? `The start of it, ${read}` : read;
    },
    // A refused read (turned off, not a text item, not found) read nothing, and the line says so.
    basedOn: (_input, _ctx, result) => (result?.available === false ? 'an item your team added (couldn’t read it)' : 'an item your team added'),
    terms: { available: 'Read', chars: 'Characters', truncated: 'Cut short' },
  },
  // Your data: propose_data_item (api/src/chat/tools/propose-data.ts) shows as its item card (ui/ItemProposalCard.tsx),
  // not a row: a proposal is not something TownwiseAI read, so it is not in the Based on line either.
  propose_data_item: {
    object: () => 'text to keep on Your data',
    hidden: true,
  },
  // The forecast lab (api/src/chat/tools/calibration.ts), org admins only. Views carry counts and codes, never a figure;
  // the codes show as words, and a calibration's id is left out.
  start_calibration: {
    // It starts a job rather than reading: "Starting a forecast calibration", and no piece of the Based on line.
    object: () => 'a forecast calibration',
    status: (state, result) => {
      if (state === 'running') return 'Starting';
      if (state === 'error') return 'Couldn’t start';
      return result?.started === true ? 'Started' : result?.started === false ? 'Didn’t start' : 'Asked to start';
    },
    detail: (result) => (result.started === true ? 'Running on Townwise’s servers' : wordsFor(START_REFUSAL, text(result, 'code'))),
    basedOn: () => null,
    terms: { hasRegimeStart: 'Pattern change date given', started: 'Started', status: 'Status', code: 'Reason' },
    values: { status: CALIBRATION_STATUS, code: START_REFUSAL },
  },
  get_calibration: {
    object: () => 'your latest forecast calibration',
    detail: (result) => labDetail(result),
    terms: { available: 'Available', status: 'Status', weeks: 'Held-out weeks', published: 'Published' },
    values: { status: CALIBRATION_STATUS },
  },
  compare_forecast_models: {
    object: () => 'how the calibration compares with the current forecast',
    detail: (result) => labDetail(result),
    terms: { available: 'Available', status: 'Status', weeks: 'Held-out weeks', published: 'Published' },
    values: { status: CALIBRATION_STATUS },
  },
};

const GENERIC = { running: 'Looking something up', done: 'Looked something up', error: 'Couldn’t look something up' } as const;

export function isKnownTool(name: string): boolean {
  return Object.hasOwn(TOOLS, name);
}

/** propose_note, propose_data_item, show_visual and suggest_next show as what they make (a proposal card, an item card, a visual, next questions), not a tool card. */
export function isHiddenTool(name: string): boolean {
  return TOOLS[name]?.hidden === true;
}

export interface ToolLine {
  /** "Reading", "Read" or "Couldn’t read", or a tool's own word ("Starting"); empty for a tool this table doesn't know. */
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
  const status = row.status?.(step.state, step.result)
    ?? (step.state === 'running' ? 'Reading' : step.state === 'done' ? 'Read' : 'Couldn’t read');
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
 * nothing and is left out, as is one that reads nothing (start_calibration); a reply with no reads is "Based on this
 * conversation only."
 */
export function basedOnLine(steps: readonly ToolStep[], ctx: ToolContext): string {
  const pieces: string[] = [];
  for (const step of steps) {
    if (step.state !== 'done' || isHiddenTool(step.name)) continue;
    const row = Object.hasOwn(TOOLS, step.name) ? TOOLS[step.name] : undefined;
    const piece = row === undefined
      ? 'something else TownwiseAI looked up'
      : (row.basedOn ?? row.object)(step.input, ctx, step.result);
    if (piece !== null && !pieces.includes(piece)) pieces.push(piece);
  }
  return pieces.length === 0 ? 'Based on this conversation only.' : `Based on ${list(pieces)}.`;
}

/**
 * What TownwiseAI reads, from the registered tools: "your sales, your notes and Hanover’s town profile". With
 * `sales: false`, or a context whose `hasSales` is false, what it can use before any sales are uploaded.
 */
export function readsLine(ctx: ToolContext, opts: { sales?: boolean } = {}): string {
  const sales = opts.sales ?? ctx.hasSales;
  const reads: string[] = [];
  for (const row of Object.values(TOOLS)) {
    if (sales === false && row.needsSales === true) continue;
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
 * `name` lets a tool's own words replace the shared ones (get_forecast's `available` is not "Researched"), and its
 * code fields show only as its words for them (a calibration's status), never as the code.
 */
export function viewRows(input: ToolView | null, result: ToolView | null, name?: string): { term: string; value: string }[] {
  const tool = name !== undefined && Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
  const own = tool?.terms;
  const codes = tool?.values;
  const rows: { term: string; value: string }[] = [];
  for (const view of [input, result]) {
    if (view === null) continue;
    for (const [key, value] of Object.entries(view)) {
      const term = own !== undefined && Object.hasOwn(own, key) ? own[key] : Object.hasOwn(VIEW_TERMS, key) ? VIEW_TERMS[key] : undefined;
      const words = codes !== undefined && Object.hasOwn(codes, key) ? codes[key] : undefined;
      const shown = term === undefined ? null : words === undefined ? valueText(key, value) : wordsFor(words, typeof value === 'string' ? value : null);
      if (term !== undefined && shown !== null && !rows.some((row) => row.term === term)) rows.push({ term, value: shown });
    }
  }
  return rows;
}
