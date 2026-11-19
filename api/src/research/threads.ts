// The research threads (D66, openspec/changes/town-research-agent design decision 3): what each thread of a run looks
// for, how many searches it may make, and the window it looks over. Pure. A town run has six threads, shared by every
// restaurant in the town; a location run has the restaurant's own two, plus one combined town thread when its town is
// not one of the twelve (a typed town name never becomes a shared key). The thread's focus goes in the request's user
// message, not its system prompt, so a town's six threads send one system prompt and share its cache (prompt.ts).
import { localDay } from '../time-zones.ts';
import type { TownId } from '../towns.ts';

export const TOWN_THREADS = ['schools', 'sports', 'arts_festivals', 'civic', 'tourism_seasonal', 'markets_community'] as const;
export const LOCATION_THREADS = ['neighborhood', 'competitors', 'town_overview'] as const;

export type TownThreadId = typeof TOWN_THREADS[number];
export type LocationThreadId = typeof LOCATION_THREADS[number];
export type ThreadId = TownThreadId | LocationThreadId;

/** Where a location thread's findings come from, as the location's events store it (`origin`). */
export type LocationOrigin = 'neighborhood' | 'competitor' | 'town_overview';

/** [CONFIRM: 8 searches a town thread, 5 a location thread; page fetch off until the live eval shows it pays] */
export const TOWN_MAX_SEARCHES = 8;
export const LOCATION_MAX_SEARCHES = 5;
/** Page fetches a thread may make while TOWNWISE_RESEARCH_WEB_FETCH is on; none while it is off. */
export const MAX_FETCHES = 2;

/** [CONFIRM: research looks 180 days ahead] */
export const RESEARCH_WINDOW_DAYS = 180;

export interface ThreadDef {
  readonly id: ThreadId;
  readonly subject: 'town' | 'location';
  /** One sentence for the request: what this thread looks for. */
  readonly focus: string;
  readonly maxSearches: number;
  /** Whether the request names the restaurant (prompt.ts `restaurant`). */
  readonly namesRestaurant: boolean;
  /** A location thread's `origin`; null on a town thread. */
  readonly origin: LocationOrigin | null;
}

/** What a run researches: a town of the twelve, or one location (whose town may be outside the twelve, `townId` null). */
export type ResearchSubject =
  | { readonly kind: 'town'; readonly townId: TownId }
  | { readonly kind: 'location'; readonly townId: TownId | null };

/** [CONFIRM: the six town threads and the two location threads] */
const TOWN_FOCUS: Readonly<Record<TownThreadId, string>> = {
  schools: 'Schools and colleges: commencement, move-in and move-out, reunions, family and homecoming weekends, admitted-student days, breaks, and K-12 vacations. Term days already in the known list are known; report only what is not.',
  sports: 'Sports: home games and meets of the college and high school teams, tournaments, races and other sporting events in or near town that bring visitors.',
  arts_festivals: 'Arts and festivals: concerts, theater, exhibitions, film and book festivals, fairs, parades and holiday celebrations.',
  civic: 'Civic happenings: town meetings, elections, road work, street and bridge closures, parking changes, construction and utility work that change who can reach downtown.',
  tourism_seasonal: 'Tourism and seasons: peak and off seasons, foliage, ski and summer seasons, holiday weekends, cruise or tour arrivals, and lodging-heavy weekends.',
  markets_community: 'Markets and community: farmers markets, craft fairs, fundraisers, races and walks, open houses, library and community center events.',
};

/** The location's own threads; `competitors` depends on whether Google's names may go to Anthropic (decision 10). */
function locationFocus(id: LocationThreadId, placesToAi: boolean): string {
  switch (id) {
    case 'neighborhood':
      return 'The restaurant named in the request and its block: its own public events (trivia, live music, specials, tastings, holiday hours), the schedules of venues next to it, and street closures or construction on its street.';
    case 'competitors':
      return placesToAi
        ? 'The competing restaurants, bars and cafes listed in the request: their public events that compete for the same guests (trivia nights, live music, specials, tastings, festivals), and openings or closings.'
        : 'Restaurants, bars and cafes in town that compete with the restaurant named in the request: their public events that compete for the same guests (trivia nights, live music, specials, tastings, festivals), and openings or closings. Name each business.';
    case 'town_overview':
      return 'The town as a whole, in one pass: school and college calendars, sports, arts and festivals, civic closures and road work, tourism seasons, and markets and community events.';
  }
}

function townThread(id: TownThreadId): ThreadDef {
  return { id, subject: 'town', focus: TOWN_FOCUS[id], maxSearches: TOWN_MAX_SEARCHES, namesRestaurant: false, origin: null };
}

function locationThread(id: LocationThreadId, placesToAi: boolean): ThreadDef {
  return {
    id, subject: 'location', focus: locationFocus(id, placesToAi), maxSearches: LOCATION_MAX_SEARCHES,
    namesRestaurant: id !== 'town_overview', origin: id === 'competitors' ? 'competitor' : id,
  };
}

/**
 * A run's threads. A location gets `neighborhood` and `competitors` whatever `placesToAi` says (with it off, the
 * restaurant is named by its own typed name and competitors are found on the web), and `town_overview` when its town is
 * outside the twelve. [CONFIRM: a town outside the twelve researched only by its locations' own combined thread, paid by
 * the organization]
 */
export function threadsFor(subject: ResearchSubject, options: { readonly placesToAi: boolean }): ThreadDef[] {
  if (subject.kind === 'town') return TOWN_THREADS.map(townThread);
  const ids: LocationThreadId[] = subject.townId === null ? ['neighborhood', 'competitors', 'town_overview'] : ['neighborhood', 'competitors'];
  return ids.map((id) => locationThread(id, options.placesToAi));
}

/** One thread by id, as threadsFor would define it. */
export function threadDef(id: ThreadId, options: { readonly placesToAi: boolean }): ThreadDef {
  return (TOWN_THREADS as readonly string[]).includes(id) ? townThread(id as TownThreadId) : locationThread(id as LocationThreadId, options.placesToAi);
}

export interface ResearchWindow { readonly from: string; readonly to: string }

function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Today in the town's time zone to today plus RESEARCH_WINDOW_DAYS, inclusive. */
export function researchWindow(now: Date, timeZone: string): ResearchWindow {
  const from = localDay(now, timeZone);
  return { from, to: plusDays(from, RESEARCH_WINDOW_DAYS) };
}
