// Back to the same TownwiseAI conversation (spec P25 build note, 2026-11-18; owner: "if i am on a chat and navigate
// somewhere else. if i go back to that page within 5 minutes then i should still be on that chat instead of the new
// chat page"). When the page closes on a conversation it keeps `{ conversationId, leftAt }` per signed-in person,
// location and view-as target, in this browser's localStorage on web (lastChatStore.web.ts) and the device's secure
// store on iOS and Android (lastChatStore.ts). Only an id and a time: never a message, a title or anything in a URL.
// Storage that is missing, throws or holds anything else reads as nothing kept, and the page opens on a new chat.

/** How long after leaving the page coming back opens the same conversation. */
export const RETURN_MS = 5 * 60 * 1000;

/** Where the memory is kept: get, set and remove one string by key. Each never rejects. */
export interface LastChatStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const PREFIX = 'townwise.chatReturn';

/** An id in the characters a secure store key allows ([A-Za-z0-9-]), every other character written as `_{hex}_`. */
function part(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`);
}

/** The key for one person, location and view-as target (null: the person's own). Distinct parts give distinct keys. */
export function lastChatKey(userId: string, locationId: string, viewAsId: string | null): string {
  return [PREFIX, part(userId), part(locationId), viewAsId === null ? 'self' : `as-${part(viewAsId)}`].join('.');
}

/** Keeps the conversation the page closed on, at `now` (ms since the epoch); null forgets it (a new chat). */
export function rememberChat(store: LastChatStore, key: string, conversationId: string | null, now: number): Promise<void> {
  return conversationId === null ? store.remove(key) : store.write(key, JSON.stringify({ conversationId, leftAt: now }));
}

export function forgetChat(store: LastChatStore, key: string): Promise<void> {
  return store.remove(key);
}

/** The conversation kept under `key` when the page closed on it at most 5 minutes before `now`; else null, forgotten. */
export async function recallChat(store: LastChatStore, key: string, now: number): Promise<string | null> {
  const raw = await store.read(key);
  if (raw === null) return null;
  const kept = parsed(raw);
  const away = kept === null ? -1 : now - kept.leftAt;
  if (kept !== null && away >= 0 && away <= RETURN_MS) return kept.conversationId;
  await store.remove(key);
  return null;
}

function parsed(raw: string): { conversationId: string; leftAt: number } | null {
  try {
    const value = JSON.parse(raw) as { conversationId?: unknown; leftAt?: unknown } | null;
    if (typeof value !== 'object' || value === null) return null;
    const { conversationId, leftAt } = value;
    if (typeof conversationId !== 'string' || conversationId === '' || conversationId.length > 64) return null;
    return typeof leftAt === 'number' && Number.isFinite(leftAt) ? { conversationId, leftAt } : null;
  } catch {
    return null;
  }
}
