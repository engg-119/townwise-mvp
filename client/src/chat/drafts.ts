// What the person has typed into TownwiseAI's composer and not sent, kept per person, location and conversation
// (null: a new conversation). In memory only: drafts survive opening another conversation and leaving the page and
// coming back, but not a reload, because nothing is kept in browser or device storage (spec P25).

const drafts = new Map<string, string>();

export function draftKey(userId: string, locationId: string, conversationId: string | null): string {
  // JSON keeps the parts apart: ('a', 'bc') and ('ab', 'c') differ, and so do null and 'null'.
  return JSON.stringify([userId, locationId, conversationId]);
}

/** The draft kept under `key`; empty when there is none. */
export function readDraft(key: string): string {
  return drafts.get(key) ?? '';
}

/** Keeps `text` under `key`; empty text forgets the draft. */
export function writeDraft(key: string, text: string): void {
  if (text === '') drafts.delete(key);
  else drafts.set(key, text);
}

/** Forgets every draft (tests). */
export function resetDrafts(): void {
  drafts.clear();
}
