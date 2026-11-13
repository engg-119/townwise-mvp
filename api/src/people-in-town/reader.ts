// The PeopleInTownReader port (spec 13.2): one location's people in town window, read from the town calendar
// (town-calendar.ts), the town profile's jobs index, the researched headcount inputs, and the location's own days and
// notes for "your history". The people in town route and TownwiseAI's get_people_in_town both read it. It logs
// nothing and stores nothing.
import type { OrgScope } from '../access/policy.ts';
import { scheduledRules } from '../forecasts/adjust.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { timeZoneOf } from '../time-zones.ts';
import { townCalendarCovers, townEvents } from '../town-calendar.ts';
import { TOWN_PROFILES } from '../town-profiles.ts';
import { TOWNS } from '../towns.ts';
import { peopleInTownWindow, type PeopleInTownWindow } from './estimate.ts';
import { yourHistory } from './history.ts';
import type { PeopleData } from './sources.ts';
import { termEntries, termStateOn } from './term.ts';

export interface PeopleInTownReader {
  /** The researched headcount inputs it reads (sources.ts in production). */
  readonly data: PeopleData;
  /** `range`: inclusive YYYY-MM-DD days, at most 92 (callers check). */
  window(input: { scope: OrgScope; location: LocationRecord; range: { from: string; to: string } }): Promise<PeopleInTownWindow>;
}

export function createPeopleInTownReader(deps: { stores: Pick<TownwiseStores, 'salesDays' | 'notes' | 'businessRules'>; data: PeopleData }): PeopleInTownReader {
  return {
    data: deps.data,
    async window({ scope, location, range }) {
      const { town } = location;
      const covers = townCalendarCovers(town.townId);
      const terms = covers === null ? [] : termEntries(townEvents(town.townId, covers));
      const termOn = (date: string) => termStateOn(date, terms);
      const [days, notes, scheduled] = await Promise.all([
        deps.stores.salesDays.history(scope, location.id),
        deps.stores.notes.list(scope, location.id),
        deps.stores.businessRules.scheduled(scope, location.id),
      ]);
      // A rule's schedule closes a day or says it was open, as a note does (D31, D32).
      const rules = scheduledRules(scheduled).map((rule) => rule.schedule);
      const first = days[0]?.date;
      const last = days.at(-1)?.date;
      const historyEvents = first === undefined || last === undefined ? [] : townEvents(town.townId, { from: first, to: last });
      return peopleInTownWindow({
        town,
        record: TOWNS.find((record) => record.townId === town.townId),
        profile: TOWN_PROFILES.find((profile) => profile.townId === town.townId),
        data: deps.data,
        range,
        timeZone: timeZoneOf(town).timeZone,
        events: townEvents(town.townId, range),
        termOn,
        history: yourHistory(days, notes, historyEvents, (date) => termOn(date).state, rules),
      });
    },
  };
}
