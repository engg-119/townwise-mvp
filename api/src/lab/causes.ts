// What started a system calibration (D65, openspec change forecast-training-status, design decision 5). `requestedBy.via`
// says only `scheduled` for both the weekly refresh and a D59 refit, so the owner's run history could not say why a
// forecast was made. Every caller of wantRefit names its cause, the refit mark keeps the set since it was last cleared,
// and the hourly pass carries them onto the calibration it starts; the weekly path stores `weekly`. A person's start
// stores none (its cause is read from `requestedBy.role`). `via` is unchanged, so the console, the infra pins on it and
// the forecasts_failed alert are untouched. Pure: nothing here reads, writes or logs.

/**
 * `weekly`: the weekly refresh. `sales`: sales days were applied (the upload route, staff setup's upload, the file
 * reader). `person_change`: a person's note or rule, or an undo. `townwise_ai`: a change TownwiseAI saved (D59 changes,
 * an automatic read's days, a calendar's answers).
 */
export type Cause = 'weekly' | 'sales' | 'person_change' | 'townwise_ai';

/** Every cause, in the order the history words them; a stored value outside it is refused (`enum`). */
export const CAUSES: readonly Cause[] = ['weekly', 'sales', 'person_change', 'townwise_ai'];
