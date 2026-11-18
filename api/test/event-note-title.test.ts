// A file event's title as a note's title (D49), without Docker: cleaned (NFC, white space, control and format
// characters removed), then cut to the note's 120 code points, so the event is still made when NFC lengthens a title
// the reader kept to 120 characters. Synthetic titles.
import { describe, expect, it } from 'vitest';

import { detailSays, eventNoteTitle } from '../src/files/ai-actions.ts';
import { MAX_NOTE_TITLE_CHARS } from '../src/stores/notes.ts';

describe('eventNoteTitle', () => {
  it('cleans a title and leaves null when nothing is left', () => {
    expect(eventNoteTitle('  Harvest\n fair​ ')).toBe('Harvest fair');
    expect(eventNoteTitle('​‮')).toBeNull();
  });

  it('cuts to 120 code points after cleaning, never between a surrogate pair', () => {
    // U+0958 is 1 code point that NFC writes as 2, so 120 of them clean to 240.
    const lengthened = eventNoteTitle('क़'.repeat(MAX_NOTE_TITLE_CHARS));
    expect(Array.from(lengthened ?? '').length).toBeLessThanOrEqual(MAX_NOTE_TITLE_CHARS);
    expect(eventNoteTitle('🎉'.repeat(130))).toBe('🎉'.repeat(MAX_NOTE_TITLE_CHARS));
  });
});

describe('detailSays', () => {
  it('reads a detail that is the title, or starts with it and a colon, folded', () => {
    expect(detailSays('rehearsal  DINNER', 'Rehearsal dinner')).toBe(true);
    expect(detailSays('Rehearsal dinner: party of 60', 'Rehearsal dinner')).toBe(true);
    expect(detailSays('Party of 60, back room', 'Rehearsal dinner')).toBe(false);
    expect(detailSays(null, 'Rehearsal dinner')).toBe(false);
  });
});
