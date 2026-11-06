import type { LocationSummary, OrgResponse } from '../schemas';

// Onboarding step 3 on Home (agreement 1 with session 54, build plan section 3): 54 builds the self-contained
// `onboarding/HistoryStep` (the step header, export tips, the drop zone and its status) and exports
// `needsHistory(org, locations)`. Until 54's onboarding merges, this file stands in for both behind the same names,
// and Home imports them only from here. When it merges, this file becomes a re-export of 54's two names and
// HistoryStepStub.tsx is deleted.

export { HistoryStep } from './HistoryStepStub';

/** The stand-in rule: the organization has locations and none of them has a stored day yet. */
export function needsHistory(_org: OrgResponse, locations: readonly LocationSummary[]): boolean {
  return locations.length > 0 && locations.every((location) => location.coverage.dayCount === 0);
}
