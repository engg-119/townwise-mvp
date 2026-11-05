// The twelve researched towns (spec Section 13), from townwise-home.json (schema 1, year 2024).
// test/towns.test.ts pins the ids as a literal list; the client pins the same list on its side.
import { z } from 'zod';

export const TOWN_IDS = [
  'hanover-nh', 'amherst-ma', 'ithaca-ny', 'burlington-vt', 'middlebury-vt', 'state-college-pa',
  'bar-harbor-me', 'stowe-vt', 'conway-nh', 'north-elba-ny', 'provincetown-ma', 'nantucket-ma',
] as const;

export type TownId = typeof TOWN_IDS[number];

export interface TownRecord {
  readonly townId: TownId;
  readonly name: string;
  readonly state: string;
  readonly kind: 'college' | 'seasonal' | 'event';
}

export const TOWNS: readonly TownRecord[] = [
  { townId: 'hanover-nh', name: 'Hanover', state: 'NH', kind: 'college' },
  { townId: 'amherst-ma', name: 'Amherst', state: 'MA', kind: 'college' },
  { townId: 'ithaca-ny', name: 'Ithaca', state: 'NY', kind: 'college' },
  { townId: 'burlington-vt', name: 'Burlington', state: 'VT', kind: 'college' },
  { townId: 'middlebury-vt', name: 'Middlebury', state: 'VT', kind: 'college' },
  { townId: 'state-college-pa', name: 'State College', state: 'PA', kind: 'college' },
  { townId: 'bar-harbor-me', name: 'Bar Harbor', state: 'ME', kind: 'seasonal' },
  { townId: 'stowe-vt', name: 'Stowe', state: 'VT', kind: 'seasonal' },
  { townId: 'conway-nh', name: 'Conway', state: 'NH', kind: 'seasonal' },
  { townId: 'north-elba-ny', name: 'North Elba', state: 'NY', kind: 'event' },
  { townId: 'provincetown-ma', name: 'Provincetown', state: 'MA', kind: 'seasonal' },
  { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA', kind: 'seasonal' },
];

/** The fixed list for “another town”: the 50 states and DC. */
export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

/** Stored on requests and locations (spec 10.1 `Town`). */
export interface Town {
  readonly townId: TownId | null;
  readonly name: string;
  readonly state: string;
}

/** Spec 10.1 `TownInput`: one of the twelve by id, or another town by name and state. */
export const townInputSchema = z.union([
  z.object({ townId: z.string() }),
  z.object({ townId: z.null(), name: z.string().trim().min(1).max(80), state: z.enum(US_STATE_CODES) }),
]);

export type TownInput = z.infer<typeof townInputSchema>;

/** The town to store: name and state come from the list for the twelve. Null for an id outside it (`unknown_town`). */
export function resolveTown(input: TownInput): Town | null {
  if (input.townId === null) return { townId: null, name: input.name, state: input.state };
  const found = TOWNS.find((town) => town.townId === input.townId);
  return found === undefined ? null : { townId: found.townId, name: found.name, state: found.state };
}
