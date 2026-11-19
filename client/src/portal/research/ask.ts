// Ask TownwiseAI on a found event (D66 design decision 12): the Calendar's day panel opens TownwiseAI on a new
// conversation with a draft naming the event's title and date (copy.ts askDraft), for the person to edit and send.
// The draft is handed over in memory, never in the address: a title can name a business, and the address is logged
// (CLAUDE.md, Privacy rules in code). The Calendar leaves it here and opens `agent?ask=found`; the TownwiseAI page takes
// it once, for the same location only. A reload in between loses it, and the page opens as it would without it.

let pending: { readonly locationId: string; readonly text: string } | null = null;

/** The address's query that tells the TownwiseAI page to take the draft. */
export const ASK_FOUND_QUERY = 'ask=found';

/** Leaves `text` for the location's TownwiseAI page, replacing any draft left before. */
export function handOffAsk(locationId: string, text: string): void {
  pending = { locationId, text };
}

/** The draft left for this location, once; null when none was left, or it was for another location. */
export function takeAsk(locationId: string): string | null {
  const kept = pending;
  pending = null;
  return kept?.locationId === locationId ? kept.text : null;
}
