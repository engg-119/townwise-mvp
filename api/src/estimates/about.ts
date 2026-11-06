// "How Townwise estimates" (spec 13.2, the model card): what Townwise's estimates read, what they can't see, their
// known limits and who can see the model, plus one location's state: today in its town, its calendar coverage, which
// headcount inputs are researched for its town, and its forecast: the newest run staff published for it and how it
// has done so far, or none (spec 14.4). One source for what the Analytics card says and what TownwiseAI says. Facts
// only from committed docs and the published run's own metadata; no figure from a model.
import { localDay, timeZoneOf, weekdayOf, type Weekday } from '../time-zones.ts';
import { townCalendarCovers } from '../town-calendar.ts';
import type { Town } from '../towns.ts';
import type { ForecastRunView } from '../forecasts/reader.ts';
import type { LiveAccuracy } from '../forecasts/score.ts';
import type { PeopleData, PeopleSource } from '../people-in-town/sources.ts';

/** Bumped whenever a sentence below changes, so a reader can tell which card it saw. */
export const MODEL_CARD_VERSION = '2026-11-05';

export interface ModelCardFacts {
  estimates: string;
  inputs: readonly string[];
  cannotSee: readonly string[];
  limits: readonly string[];
  checked: string;
  whoCanSee: string;
}

export const MODEL_CARD: ModelCardFacts = {
  estimates: 'Guests per day and per week, each as a range (about 8 in 10 days should land inside it), never one exact number.',
  inputs: [
    'Your daily guests and net sales.',
    'Your notes: closures, private events and other unusual days.',
    'Your town’s calendar: term dates, events and holidays, each with its source.',
    'For people in town: the county’s food-service jobs by month, and public counts where Townwise has researched them.',
  ],
  cannotSee: [
    'Weather.',
    'Your stock and orders.',
    'Your staffing.',
    'Bookings, unless you add them as notes.',
    'Menu or price changes.',
    'How your staff count guests.',
  ],
  limits: [
    'Big holiday nights rest on three nights from one year.',
    'Guest counts are entered by staff, and guests per order changed over 2025 and 2026.',
    'The model was built for one restaurant and is not yet trained for others.',
  ],
  checked: 'Forecasts are saved before their days happen and scored openly afterwards, misses included.',
  whoCanSee: 'Townwise staff only. You see its outputs; TownwiseAI reads them for you.',
};

export type HeadcountInput = 'residents' | 'studentHousing' | 'enrollment' | 'housingCloses' | 'eventAttendance' | 'visitors';

export interface EstimatesAbout {
  version: string;
  card: ModelCardFacts;
  location: { name: string; town: { name: string; state: string } };
  today: { date: string; weekday: Weekday; timeZone: string; approximate: boolean };
  /** Null run until staff publish a forecast for this location (U13B); live is null under 5 scored days. */
  forecast: { run: ForecastRunView | null; live: LiveAccuracy | null };
  calendar: { researched: boolean; covers: { from: string; to: string } | null };
  /** Empty while no headcount input is researched for the town. */
  people: { headcountInputs: HeadcountInput[]; sources: PeopleSource[] };
}

export function estimatesAbout(
  location: { name: string; town: Town },
  data: PeopleData,
  now: Date,
  forecast: { run: ForecastRunView; live: LiveAccuracy | null } | null = null,
): EstimatesAbout {
  const { town } = location;
  const zone = timeZoneOf(town);
  const date = localDay(now, zone.timeZone);
  const covers = townCalendarCovers(town.townId);
  const entry = town.townId === null ? undefined : data.towns.find((each) => each.townId === town.townId);
  const inputs: [HeadcountInput, string | null][] = entry === undefined ? [] : [
    ['residents', entry.residents?.sourceId ?? null],
    ['studentHousing', entry.studentHousing?.sourceId ?? null],
    ['enrollment', entry.enrollment?.sourceId ?? null],
    ['housingCloses', entry.housingClosesBetweenTerms?.sourceId ?? null],
    ...entry.eventAttendance.map((row): [HeadcountInput, string] => ['eventAttendance', row.sourceId]),
    ['visitors', entry.visitors?.sourceId ?? null],
  ];
  const present = inputs.filter((input): input is [HeadcountInput, string] => input[1] !== null);
  const ids = new Set(present.map(([, id]) => id));
  return {
    version: MODEL_CARD_VERSION,
    card: MODEL_CARD,
    location: { name: location.name, town: { name: town.name, state: town.state } },
    today: { date, weekday: weekdayOf(date), timeZone: zone.timeZone, approximate: zone.approximate },
    forecast: forecast === null ? { run: null, live: null } : { run: forecast.run, live: forecast.live },
    calendar: { researched: covers !== null, covers },
    people: {
      headcountInputs: [...new Set(present.map(([input]) => input))],
      sources: data.sources.filter((source) => ids.has(source.id)),
    },
  };
}
