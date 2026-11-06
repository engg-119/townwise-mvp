// Onboarding step 3 on Home (agreement 1 with session 54, build plan section 3): Home imports the step and its rule
// only from here. Both now live in `onboarding/` (HistoryStep, the drop and Reading screen, and history.ts).

export { HistoryStep } from '../onboarding/HistoryStep';
export { needsHistory } from '../onboarding/history';
