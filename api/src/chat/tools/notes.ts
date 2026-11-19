// list_notes: the notes already recorded for the location. D59 slice 4: listing one whose words may not be a person's
// (shared.ts notTypedNote) sets the turn's readNotTyped.
import { z } from 'zod';

import type { ChatTool } from './registry.ts';
import { INVALID_INPUT, NO_INPUT, notTypedNote, parseNoInput, viewOf } from './shared.ts';

const notesResult = z.object({ notes: z.array(z.unknown()) });

export const notesTool: ChatTool<Record<string, never>> = {
  definition: {
    name: 'list_notes',
    description: 'The notes already recorded for this location, by start date: kind, dates, weekdays, hours, effect, expected guests, title (the event’s name, or null) and detail.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: parseNoInput,
  inputView: () => null,
  resultView: (content) => viewOf(content, notesResult, ({ notes }) => ({ count: notes.length })),
  async run(tc) {
    const list = await tc.ctx.stores.notes.list(tc.scope, tc.location.id);
    // D59 slice 4: a note written from a file or a calendar carries words no person typed, so propose_note saves nothing itself.
    if (list.some(notTypedNote)) tc.turn.readNotTyped = true;
    return {
      content: JSON.stringify({
        notes: list.map((note) => ({
          kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, startTime: note.startTime,
          endTime: note.endTime, effect: note.effect, expectedGuests: note.expectedGuests, title: note.title, detail: note.detail,
        })),
      }),
    };
  },
};
