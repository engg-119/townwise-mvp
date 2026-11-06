// propose_note: validates a note through the notes rules and shows it to the owner as a proposal. It never writes.
import { readNoteContent } from '../../handlers/notes.ts';
import type { NoteContent } from '../../stores/notes.ts';
import type { ChatTool } from './registry.ts';
import { DATE } from './shared.ts';

/** Spec text: "Shown to the owner as a proposal. They decide whether to add it." */
export const PROPOSAL_RESULT = 'Shown to the owner as a proposal. They decide whether to add it.';

export const proposeNoteTool: ChatTool<NoteContent> = {
  definition: {
    name: 'propose_note',
    description: 'Shows the owner a proposed note as a card with Add note and Dismiss. It never adds the note. Rules: dates from 2010-01-01 to two years after today; endDate on or after startDate and at most 366 days later; weekdays null for every day in the range, or unique numbers from 0 (Sunday) to 6; expectedGuests a whole number from 1 to 20000 or null, and null when effect is closed; detail at most 280 characters, required when kind is other.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['closure', 'private_event', 'opening', 'other'] },
        startDate: DATE,
        endDate: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
        weekdays: { type: ['array', 'null'], items: { type: 'integer', minimum: 0, maximum: 6 } },
        effect: { type: 'string', enum: ['closed', 'more_guests', 'fewer_guests', 'unknown'] },
        expectedGuests: { type: ['integer', 'null'], minimum: 1, maximum: 20000 },
        detail: { type: ['string', 'null'], maxLength: 280 },
      },
      required: ['kind', 'startDate', 'endDate', 'weekdays', 'effect', 'expectedGuests', 'detail'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Not a valid note, so nothing was shown to the owner. Check the rules in the tool description and try again.',
  parse: (raw, tc) => readNoteContent(raw, tc.today),
  run: (_tc, note) => Promise.resolve({ content: PROPOSAL_RESULT, proposal: note }),
};
