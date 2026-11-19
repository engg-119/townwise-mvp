import type { LastChatStore } from '../../chat/lastChat';
import type { LocationRun } from './api';

// The Calendar's research banner (D66 design decision 15): it shows only for a run a person started (Research now, or
// the early run after a location is created or its place picked), while it runs and after it finishes, until the person
// dismisses it or opens the Town tab. Which run was seen is remembered on the device, per person and location, in the
// same store the TownwiseAI page keeps its last conversation in (localStorage on web, the secure store on iOS and
// Android; chat/lastChatStore), as one string: the run's start, so the next run a person starts shows again. A store
// that is missing or fails reads as nothing seen, so the banner shows; never a title or anything a run found.

const PREFIX = 'townwise.researchSeen';

/** An id in the characters a secure store key allows ([A-Za-z0-9-]), every other character written as `_{hex}_`. */
function part(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`);
}

export function researchSeenKey(userId: string, locationId: string): string {
  return [PREFIX, part(userId), part(locationId)].join('.');
}

/** What marks one run: its start, or `queued` before it starts. */
export function runMark(run: Pick<LocationRun, 'startedAt'>): string {
  return run.startedAt ?? 'queued';
}

/** Whether the banner shows for `run`: one a person started that was not seen (`seen`, the mark kept) yet. */
export function bannerShows(run: Pick<LocationRun, 'trigger' | 'startedAt'> | null, seen: string | null): boolean {
  return run !== null && run.trigger !== 'weekly' && runMark(run) !== seen;
}

export async function readSeen(store: LastChatStore, userId: string, locationId: string): Promise<string | null> {
  try {
    return await store.read(researchSeenKey(userId, locationId));
  } catch {
    return null;
  }
}

/** Remembers `run` as seen: the Calendar's Dismiss, and the Town tab when it opens. */
export function markSeen(store: LastChatStore, userId: string, locationId: string, run: Pick<LocationRun, 'startedAt'>): Promise<void> {
  return store.write(researchSeenKey(userId, locationId), runMark(run)).catch(() => undefined);
}
