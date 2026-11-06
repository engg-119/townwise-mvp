// The Reading calendar's move into Home's history card (storage2 2.2, spec P11). Native draws no calendar
// (D21), so there is nothing to measure or move: the step leaves and Home shows its cards. The web version is
// historyMotion.web.ts, with the same signatures.

export interface Box { x: number; y: number; width: number; height: number }

/** No calendar is drawn on native, so there is never a box to start from. */
export function boxOf(nativeID: string): Box | null {
  return nativeID === '' ? null : null;
}

/** Nothing moves on native: Home's cards simply replace the step. */
export function arriveAtHome(from: Box | null, animate: boolean): void {
  if (from === null || !animate) return;
}
