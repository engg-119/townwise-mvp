// list_notes: the notes already recorded for the location.
import type { ChatTool } from './registry.ts';
import { INVALID_INPUT, NO_INPUT, parseNoInput } from './shared.ts';

export const notesTool: ChatTool<Record<string, never>> = {
  definition: {
    name: 'list_notes',
    description: 'The notes already recorded for this location, by start date: kind, dates, weekdays, effect, expected guests and detail.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: parseNoInput,
  async run(tc) {
    const list = await tc.ctx.stores.notes.list(tc.scope, tc.location.id);
    return {
      content: JSON.stringify({
        notes: list.map((note) => ({
          kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, effect: note.effect,
          expectedGuests: note.expectedGuests, detail: note.detail,
        })),
      }),
    };
  },
};
