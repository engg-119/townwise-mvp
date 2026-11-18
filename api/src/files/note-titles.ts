// The boot-time title backfill (D49). Notes TownwiseAI made from a file before notes had titles have no `title` key and a
// detail of "title: detail", so they would keep showing kind words. Each is named once, exactly from its file's stored
// read: the event at the note's place in the read's plan (as Your data's item view reads it, handlers/data.ts aiView),
// cleaned as a new note's title is. It is null when that event is no longer stored (the original deleted, the file
// removed or being deleted, or nothing left after cleaning). The detail is left as it is.
//
// The lookup spans organizations, so it lives in stores/cross-tenant.ts; each write runs through the tenant store under
// the note's own organization's scope, as a compare-and-set on the missing key, so a second run or a second replica
// writes nothing (no multi-document transactions). It records no audit event, since a title is never audited, and logs
// counts only. [CONFIRM: notes TownwiseAI made before titles are named once at boot from their file's read]
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForNoteTitleBackfill } from '../access/policy.ts';
import { untitledAiNotes, type UntitledAiNote } from '../stores/cross-tenant.ts';
import type { TownwiseStores } from '../stores/index.ts';
import { eventNoteTitle } from './ai-actions.ts';

/** Names every note from before titles once. Resolves the notes this run named (`titled`) and set to null (`untitled`). */
export async function backfillNoteTitles(deps: {
  connection: Connection; stores: TownwiseStores; logger: Logger;
}): Promise<{ titled: number; untitled: number }> {
  const { stores } = deps;
  const byFile = new Map<string, UntitledAiNote[]>();
  for (const note of await untitledAiNotes(deps.connection)) {
    const key = `${note.orgId}:${note.fileId}`;
    byFile.set(key, [...(byFile.get(key) ?? []), note]);
  }
  let titled = 0;
  let untitled = 0;
  for (const notes of byFile.values()) {
    const [first] = notes;
    if (first === undefined) continue;
    // One read of each file, in the note's own organization: another organization's file is never found.
    const scope = scopeForNoteTitleBackfill(first);
    const [file] = await stores.files.byIds(scope, [first.fileId]);
    const ai = file?.ai ?? null;
    for (const note of notes) {
      const event = ai?.result?.events[ai.actions?.plan.noteIds.indexOf(note.id) ?? -1];
      const title = event === undefined ? null : eventNoteTitle(event.title);
      if (await stores.notes.setTitleOnce(scope, note.id, title)) {
        if (title === null) untitled += 1;
        else titled += 1;
      }
    }
  }
  deps.logger.info({ notesTitled: titled, notesUntitled: untitled }, 'townwise.note_titles_backfilled');
  return { titled, untitled };
}
