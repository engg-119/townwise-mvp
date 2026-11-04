import type { PendingIndex } from './indexes.ts';

/**
 * Whether a missing index may build before listen().
 *
 * Building then is zero-ops for a new or small collection. On a large collection
 * it runs unreviewed at deploy time: a TTL build deletes the expired backlog, a
 * unique build fails on existing duplicates, and a long build delays listen()
 * past the health-check grace. Returning false means a human runs the one-off
 * build first. ensureIndexes, not this function, refuses to boot when a unique
 * or TTL index is missing.
 *
 * New products start empty, so this returns true for every missing index. A
 * product with a large collection must change this function before deploy,
 * because a TTL build deletes expired documents and a unique build fails on
 * duplicates.
 */
export function buildAtBoot(index: PendingIndex): boolean {
  // Every model name builds. A product with a large collection replaces this body.
  switch (index.model) {
    default:
      return true;
  }
}
