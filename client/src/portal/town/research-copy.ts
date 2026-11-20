import type { ResearchedEvent } from '../analytics/api';
import { formatCount, plural } from '../format';
import { datesLine } from '../locations/noteRules';
import { LIVE_RUN_STATUSES, type ResearchGap, type TownRun } from '../research/api';

// The Town tab's words for town research (D66, OpenSpec change town-research-agent, design decision 15): the
// Research section (status in topics, gaps, Research now and its answers, the research switch, coming up this week,
// who and where, hidden by your team) and the Competition card. Pure functions beside the components that print them
// (ResearchSection.tsx, CompetitionCard.tsx), each pinned by test/portal/town/research-copy.test.ts. Research works in
// "topics", never "threads"; plain words (15.6); no em dash. The Calendar's research words are research/copy.ts.

export const RESEARCH_HEADING = 'Town research';
export const RESEARCH_KICKER = 'Research';

/** Each topic (an API thread id) in plain words; one this client doesn't know reads "Another topic". */
const TOPIC_LABELS: Readonly<Record<string, string>> = {
  schools: 'Schools and college',
  sports: 'Sports',
  arts_festivals: 'Arts and festivals',
  civic: 'Town meetings, road work and parking',
  tourism_seasonal: 'Tourism and seasons',
  markets_community: 'Markets and community',
  neighborhood: 'Your restaurant and its neighborhood',
  competitors: 'Competitors and their events',
  town_overview: 'Your town',
};

export function topicLabel(thread: string): string {
  return TOPIC_LABELS[thread] ?? 'Another topic';
}

/** A topic's state: a queued topic with a code is waiting on a retry. */
export function topicState(thread: { status: string; code: string | null }): string {
  switch (thread.status) {
    case 'queued': return thread.code === null ? 'Queued' : 'Waiting to try again';
    case 'running': return 'Researching';
    case 'recorded': return 'Done';
    case 'empty': return 'Done, nothing found';
    case 'budget': return 'Skipped, little budget left this month';
    case 'failed': return 'Didn’t finish';
    default: return 'Queued';
  }
}

const DONE_TOPICS = ['recorded', 'empty', 'budget', 'failed'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** “Nov 17”: an instant's day in the viewer's zone, without the year. */
export function shortDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : `${SHORT_MONTHS[date.getMonth()] ?? ''} ${String(date.getDate())}`;
}

/** “Mon, Nov 23”: a YYYY-MM-DD business day. */
export function businessDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day;
  return `${SHORT_WEEKDAYS[date.getUTCDay()] ?? ''}, ${SHORT_MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
}

export function isLive(run: Pick<TownRun, 'status'> | null): boolean {
  return run !== null && LIVE_RUN_STATUSES.includes(run.status);
}

/** The subject of a status line: the town's name, or the location's own research. */
export type Subject = { kind: 'town'; name: string } | { kind: 'location' };

function subjectName(subject: Subject): string {
  return subject.kind === 'town' ? subject.name : 'Your restaurant and nearby';
}

function subjectInSentence(subject: Subject): string {
  return subject.kind === 'town' ? subject.name : 'your restaurant and nearby';
}

/**
 * A run's status line: “Researching Hanover: 3 of 6 topics done”, “Your restaurant and nearby: last researched Nov 17,
 * 9 events, 3 new”, “Hanover: Queued” (as its topics read), or why the last run ended as it did; a partial run whose
 * unfinished topics were all skipped for budget says so rather than that they didn't finish. Null run: not researched yet.
 * `paused` (research off for the organization or not running here, as the gap line says): a live run reads “Hanover:
 * paused, 2 of 6 topics done”, since nothing goes on while it is off. `waitingFor`: the town whose live run holds this
 * location run's merge (`townHolds`; design decision 8, as fixed in UI review), so a running run whose topics have all ended says
 * what it waits for (UI review) instead of sitting on “2 of 2 topics done”.
 */
export function runLine(subject: Subject, run: TownRun | null, paused = false, waitingFor: string | null = null): string {
  const name = subjectName(subject);
  if (run === null) return `${name}: not researched yet`;
  const total = run.threads.length;
  const done = run.threads.filter((thread) => DONE_TOPICS.includes(thread.status)).length;
  const on = run.finishedAt === null ? '' : ` on ${shortDay(run.finishedAt)}`;
  if (paused && isLive(run)) return total === 0 ? `${name}: paused` : `${name}: paused, ${formatCount(done)} of ${formatCount(total)} topics done`;
  switch (run.status) {
    case 'queued': return `${name}: Queued`;
    case 'running':
      if (waitingFor !== null && total > 0 && done === total) {
        return `${name}: ${formatCount(done)} of ${formatCount(total)} topics done, waiting for ${waitingFor}’s research to finish`;
      }
      return `Researching ${subjectInSentence(subject)}: ${formatCount(done)} of ${formatCount(total)} topics done`;
    case 'merging': return `Researching ${subjectInSentence(subject)}: adding what it found to the calendar`;
    case 'done':
    case 'partial': {
      const last = run.finishedAt === null ? 'last researched' : `last researched ${shortDay(run.finishedAt)}`;
      const line = `${name}: ${last}, ${plural(run.counts.found, 'event', 'events')}, ${formatCount(run.counts.added)} new`;
      if (run.status !== 'partial') return line;
      const unfinished = run.threads.filter((thread) => thread.status !== 'recorded' && thread.status !== 'empty');
      const budgetOnly = unfinished.length > 0 && unfinished.every((thread) => thread.status === 'budget');
      return `${line}. ${budgetOnly ? 'Some topics were skipped, little budget left this month.' : 'Some topics didn’t finish.'}`;
    }
    case 'failed': return `${name}: research${on} didn’t finish`;
    case 'budget': return `${name}: research${on} was skipped, little budget left this month`;
    case 'off': return `${name}: research${on} stopped before it finished`;
  }
}

/** Whether the town's run holds a location run's merge: while it is `running` or `merging` (a `queued` one does not). */
export function townHolds(run: Pick<TownRun, 'status'> | null): boolean {
  return run !== null && (run.status === 'running' || run.status === 'merging');
}

/** When the next weekly research runs, or null. */
export function nextLine(next: string | null): string | null {
  return next === null ? null : `Next weekly research: ${businessDay(next)}`;
}

/** The gaps the tab explains, in the API's order. `on` and `available` tell the two halves of `off` apart. */
export function gapLine(gap: ResearchGap, opts: { town: string; admin: boolean; on: boolean; available: boolean }): string {
  switch (gap) {
    case 'off':
      return opts.on && !opts.available
        ? 'Town research isn’t running here right now, so nothing new is being found.'
        : 'Town research is off for your organization, so nothing new is being found.';
    case 'no_place':
      return opts.admin
        ? 'This location isn’t linked to its place on Google Maps, so research skips your restaurant and its competitors and there is no map of them. Link it in Location settings.'
        : 'This location isn’t linked to its place on Google Maps, so research skips your restaurant and its competitors and there is no map of them. An admin can link it in Location settings.';
    case 'not_researched_town':
      return `${opts.town} isn’t one of the towns Townwise researches each week, so this restaurant’s research covers the town too.`;
    case 'budget':
      return opts.admin
        ? 'Little TownwiseAI budget was left this month, so some research was skipped. It runs again next month, or press Research now.'
        : 'Little TownwiseAI budget was left this month, so some research was skipped. It runs again next month.';
    case 'places_off':
      return 'Google Maps wasn’t available, so some research about your restaurant was skipped.';
  }
}

// ---- Research now ----------------------------------------------------------------------------------------------------

export const RESEARCH_NOW = 'Research now';
export const RESEARCH_NOW_HELP = 'Looks again at your restaurant, its neighborhood and its competitors. You can press it 6 hours after research last finished, up to 3 times a day.';
export const RESEARCH_NOW_RUNNING = 'Research is running. This page updates as it goes.';
export const RESEARCH_STARTED = 'Research started. This page updates as it goes.';

/**
 * Research now within 6 hours of the last run (GET .../research's `pressAt`), said up front beside the disabled button:
 * “Research ran in the last 6 hours. You can press Research now again at 3:40 pm.”, with the day when it isn't today.
 * `now` is the viewer's clock; times read in the viewer's zone.
 */
export function pressOpensLine(at: string, now: Date): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'Research ran in the last 6 hours. Try again later.';
  const time = clock(`${String(date.getHours())}:${String(date.getMinutes()).padStart(2, '0')}`);
  const today = date.toDateString() === now.toDateString();
  return `Research ran in the last 6 hours. You can press Research now again ${today ? '' : `on ${shortDay(at)} `}at ${time}.`;
}

/** Research now's refusals, by status and code; null for one the page shows with the shared copy. */
export function pressRefusal(status: number, code: string | null): string | null {
  if (status === 409 && code === 'research_running') return 'Research is already running for this location.';
  if (status === 409 && code === 'too_soon') return 'Research ran in the last 6 hours. Try again later.';
  if (status === 503 && code === 'research_off') return 'Town research is off, so it can’t run now.';
  if (status === 429) return 'You can press Research now 3 times a day. Try again tomorrow.';
  return null;
}

/** What a finished run the page saw says: how many new events, or that it didn't finish. */
export function finishedNotice(run: Pick<TownRun, 'status' | 'counts'> | null): string | null {
  if (run === null || isLive(run)) return null;
  if (run.status === 'done' || run.status === 'partial') {
    const added = run.counts.added;
    return added === 0 ? 'Research finished. Nothing new this time.' : `Research finished: ${plural(added, 'new event', 'new events')} on your calendar.`;
  }
  return 'Research didn’t finish. The lines above say why.';
}

// ---- The switch ------------------------------------------------------------------------------------------------------

/** What research does and sends (design decision 16), beside the switch, before the Privacy link. */
export function switchWords(town: string): string {
  return `Each week Townwise searches public websites for events in ${town} and near this restaurant that could change how busy you are, and puts what it finds on your calendar. It sends Anthropic your town and this restaurant’s name, never your sales, notes, calendars, or anyone’s name or email.`;
}

export function switchState(on: boolean, available: boolean): string {
  if (!on) return 'Town research is off.';
  return available ? 'Town research is on.' : 'Town research is on, but it isn’t running here right now.';
}

export function switchLabel(on: boolean): string {
  return on ? 'Turn off town research' : 'Turn on town research';
}

/** Staff open as admin see the switch only while it is on, and may only turn it off. */
export const SWITCH_OPEN_AS_ADMIN = 'You can turn this off. Only an admin of this organization can turn it back on.';
export const SWITCH_FAILED = 'Couldn’t change this. Try again.';

// ---- Coming up this week, who and where, hidden by your team ----------------------------------------------------------

export const WEEK_HEADING = 'Coming up this week';
export const WEEK_MAX = 8;
export const WEEK_EMPTY = 'Research found nothing for the next 7 days.';
/** In place of the week's list while the organization's research switch is off (nothing researched is read then). */
export const WEEK_OFF = 'Town research is off, so nothing found by research is listed.';
export const WEEK_FAILED = 'Couldn’t load what research found for this week.';

/** “+3 more on the Calendar”, or null. */
export function moreLine(more: number): string | null {
  return more <= 0 ? null : `+${formatCount(more)} more on the Calendar`;
}

/** A found event's dates, and its time when it has one. */
export function eventWhen(event: Pick<ResearchedEvent, 'start' | 'end' | 'startTime'>): string {
  const dates = datesLine({ startDate: event.start, endDate: event.end });
  return event.startTime === null ? dates : `${dates}, ${clock(event.startTime)}`;
}

function clock(time: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  if (minutes === 0 && hours === 12) return 'noon';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(hour)}${minutes === 0 ? '' : `:${String(minutes).padStart(2, '0')}`} ${hours < 12 ? 'am' : 'pm'}`;
}

/** The chips a found event carries here, as on the Calendar: Unconfirmed for low confidence, Cancelled. */
export function eventChips(event: Pick<ResearchedEvent, 'confidence' | 'status'>): string[] {
  return [event.confidence === 'low' ? 'Unconfirmed' : null, event.status === 'cancelled' ? 'Cancelled' : null].filter((chip) => chip !== null);
}

export const WHO_HEADING = 'Who and where';

const ENTITY_TYPES: Readonly<Record<string, string>> = {
  venue: 'Venue', organization: 'Organization', team: 'Team', school: 'School', business: 'Business',
};

/** “Venue · 4 upcoming events”. */
export function entityLine(entity: { type: string; events: number }): string {
  return `${ENTITY_TYPES[entity.type] ?? 'Place'} · ${plural(entity.events, 'upcoming event', 'upcoming events')}`;
}

export function hiddenHeading(count: number): string {
  return `Hidden by your team (${formatCount(count)})`;
}

export const RESTORE = 'Restore';
export function restoreLabel(title: string): string {
  return `Restore ${title}`;
}

export const RESTORE_NOTICES = {
  restored: 'Restored. It shows on the calendar again.',
  /** Restore returns research's own values (design decision 11), so an edited event's edits go with it. */
  restoredEdited: 'Restored as research found it. Your team’s edits to it were dropped.',
  changedSince: 'Someone changed this event since this page loaded. Here it is as it reads now.',
  gone: 'This event isn’t available any more.',
} as const;

// ---- The Competition card --------------------------------------------------------------------------------------------

export const COMPETITION_HEADING = 'Competition';
/** How far ahead the card lists competitors' events (the API's COMPETITION_DAYS). */
export const COMPETITION_DAYS = 60;
export const COMPETITION_LEAD = 'Restaurants, bars and cafes near you, with the public events research found for the next 60 days.';
export const COMPETITION_NO_PLACE = 'Link this location to its place on Google Maps in Location settings to see nearby competitors on a map.';
export const COMPETITION_PLACES_OFF = 'The map of nearby places isn’t available right now.';
export const COMPETITION_NONE = 'No restaurants, bars or cafes found within 1.5 km.';
export const COMPETITION_NO_EVENTS = 'No public events found.';
export const COMPETITION_WEB_HEADING = 'Competing events found on the web';
export const COMPETITION_FAILED = 'Couldn’t load the competition.';
/** Google's attribution words, joined by a no-break space so they never wrap (Places policies). */
export const GOOGLE_MAPS = 'Google Maps';
/** The colors Google allows for its text attribution: #5E5E5E on light, white on dark. */
export function googleMapsCreditColor(mode: 'light' | 'dark'): string {
  return mode === 'dark' ? '#FFFFFF' : '#5E5E5E';
}
export const COMPETITION_SOURCE_BEFORE = 'Nearby places from ';
export const COMPETITION_SOURCE_AFTER = ', read live for this page. Townwise doesn’t keep their names.';
export const COMPETITION_SOURCE = `${COMPETITION_SOURCE_BEFORE}${GOOGLE_MAPS}${COMPETITION_SOURCE_AFTER}`;

export function competitionMapLabel(name: string): string {
  return `Map of restaurants, bars and cafes near ${name}`;
}

/** A Google primary type in words: “american_restaurant” reads “American restaurant”. */
export function placeType(type: string): string {
  const words = type.replace(/_/g, ' ').trim();
  return words === '' ? 'Place' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** “350 m” under a kilometer (to the nearest 10), else “1.2 km”. */
export function distanceWords(meters: number): string {
  if (meters < 995) return `${formatCount(Math.max(10, Math.round(meters / 10) * 10))} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** “American restaurant · 350 m”. */
export function competitorLine(competitor: { type: string; distanceM: number }): string {
  return `${placeType(competitor.type)} · ${distanceWords(competitor.distanceM)}`;
}
