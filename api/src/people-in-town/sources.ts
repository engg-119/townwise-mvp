// The researched headcount inputs for people in town (spec 13.2): resident population with its margin, students in
// college housing, enrollment, whether college housing closes between terms, event attendance and visitor counts,
// each number with the public source it came from. Hand-curated by a teammate, reviewed in its PR with every URL
// opened, and checked by test/people-sources.test.ts.
//
// EMPTY ON PURPOSE. No headcount input is researched yet for any town (owner decision 3, 2026-11-05: Hanover's
// calendar is seeded, headcount inputs stay empty and labelled). While a town has no entry, every surface says
// Townwise can't put a number on how many people are in town, and shows the term, events, holidays and season it does
// know. Never fill an entry without a source a teammate has opened, and never estimate a value.
import type { TownId } from '../towns.ts';

export type Confidence = 'high' | 'medium' | 'low';

export interface PeopleSource {
  /** ^[a-z0-9-]{1,40}$, unique; never 'bls-qcew' or 'cal-{n}', which the window assigns itself. */
  readonly id: string;
  /** 'U.S. Census Bureau, 2020 Census P1' */
  readonly label: string;
  /** https only. */
  readonly url: string;
  /** YYYY-MM-DD, when the teammate read it. */
  readonly retrieved: string;
  readonly confidence: Confidence;
}

export interface TownPeopleData {
  readonly townId: TownId;
  /** moe90: the 90% margin of error, below `value`; null for a single count. */
  readonly residents: { readonly value: number; readonly moe90: number | null; readonly vintage: string; readonly sourceId: string } | null;
  readonly studentHousing: { readonly value: number; readonly vintage: string; readonly sourceId: string } | null;
  /** One institution per town: the one with the largest enrollment. */
  readonly enrollment: { readonly value: number; readonly term: string; readonly institution: string; readonly sourceId: string } | null;
  readonly housingClosesBetweenTerms: { readonly sourceId: string } | null;
  /** `group`: a town calendar group ('hanover-nh:home-football'); `high` is an upper bound. */
  readonly eventAttendance: readonly {
    readonly group: string; readonly high: number; readonly basis: 'reported_past' | 'venue_capacity'; readonly sourceId: string;
  }[];
  /** Person-entries, not people present; `month` is YYYY-MM. */
  readonly visitors: { readonly label: string; readonly monthly: readonly { readonly month: string; readonly value: number }[]; readonly sourceId: string } | null;
}

/** What the people in town reader reads. Tests pass a synthetic one; production uses PEOPLE_DATA. */
export interface PeopleData {
  readonly sources: readonly PeopleSource[];
  readonly towns: readonly TownPeopleData[];
}

export const PEOPLE_SOURCES: readonly PeopleSource[] = [];

export const TOWN_PEOPLE: readonly TownPeopleData[] = [];

export const PEOPLE_DATA: PeopleData = { sources: PEOPLE_SOURCES, towns: TOWN_PEOPLE };
