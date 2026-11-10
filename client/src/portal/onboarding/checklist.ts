import { townLine } from '../places/PlaceCard';
import type { PlaceSearchState } from './usePlaceSearch';

// The places checklist's rules and words (usePlaceChecklist.ts, PlaceChecklistParts.tsx): how many places one list
// takes, and what it says when it refuses one.

/** The most places one list takes: an organization's location limit (MAX_LOCATIONS, api/src/handlers/locations.ts). */
export const MAX_CHECKED_PLACES = 25;

export const CHECKLIST_COPY = {
  limit: `You can add up to ${String(MAX_CHECKED_PLACES)} places.`,
  gone: 'Google Maps can’t find that place any more. Search again, or enter it yourself.',
} as const;

/** Why a place outside a US town can't be checked, naming it, since the list stays where it was. */
export function outsideUsLine(name: string): string {
  return `${name}: ${townLine(null)}`;
}

/**
 * The status under the field, once per answer, as searchStatus (usePlaceSearch.ts) words it for a pick. The sentence
 * names the text it answers, so two answers with the same count still read differently.
 */
export function checklistStatus(state: Pick<PlaceSearchState, 'searched' | 'suggestions'>): string | null {
  if (state.searched === null) return null;
  const count = state.suggestions.length;
  if (count === 0) return `No places match “${state.searched}”. Check the spelling, or enter it yourself.`;
  return `${String(count)} ${count === 1 ? 'place matches' : 'places match'} “${state.searched}”. Check each one that’s yours.`;
}

/**
 * Number of locations on the request form: what the person typed, unless more places are checked than that (or they
 * typed no whole number), in which case the checked count. With nothing checked the typed text stands.
 */
export function locationCountFor(typed: string, checked: number): string {
  if (checked === 0) return typed;
  const n = /^\d+$/.test(typed.trim()) ? Number(typed) : 0;
  return String(Math.max(n, checked));
}

/** The Continue button's label for `count` checked places; “Continue with 0 places” reads badly, so 0 is just Continue. */
export function continueLabel(count: number): string {
  if (count === 0) return 'Continue';
  return count === 1 ? 'Continue with 1 place' : `Continue with ${String(count)} places`;
}

/** Add location's primary (P10) for `count` checked places: “Add location” up to one, then “Add {n} locations”. */
export function addLabel(count: number): string {
  return count <= 1 ? 'Add location' : `Add ${String(count)} locations`;
}
