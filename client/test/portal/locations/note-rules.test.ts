import { noteWords } from '../../../src/portal/analytics/panel';
import { noteSchema } from '../../../src/portal/locations/api';
import {
  checkNote, clockWords, draftOf, draftOfContent, draftOfImported, emptyDraft, hoursLine, NOTE_COPY, type NoteDraft,
} from '../../../src/portal/locations/noteRules';
import { noteOf } from './fakes';

// Note hours and buyout guests (spec 12, D30): the form checks the same rules as the API's
// readNoteContent (api/src/handlers/notes.ts), so a 400 means a client bug.

const TODAY = '2026-11-04';

function draft(patch: Partial<NoteDraft>): NoteDraft {
  return { ...emptyDraft('private_event'), startDate: '2026-12-24', ...patch };
}

describe('checkNote: hours and buyouts', () => {
  test('checkNote: times both or neither, HH:MM, start before end, none on a closure', () => {
    expect(checkNote(draft({ startTime: '18:00', endTime: '21:30' }), TODAY)).toMatchObject({ input: { startTime: '18:00', endTime: '21:30' } });
    expect(checkNote(draft({ startTime: ' 09:05 ', endTime: '23:59' }), TODAY)).toMatchObject({ input: { startTime: '09:05', endTime: '23:59' } });
    // Neither: all day.
    expect(checkNote(draft({}), TODAY)).toMatchObject({ input: { startTime: null, endTime: null } });
    // Both or neither: the empty one says so.
    expect(checkNote(draft({ startTime: '18:00' }), TODAY)).toEqual({ messages: { endTime: NOTE_COPY.timePair } });
    expect(checkNote(draft({ endTime: '21:00' }), TODAY)).toEqual({ messages: { startTime: NOTE_COPY.timePair } });
    // HH:MM, 24-hour.
    for (const bad of ['6pm', '9:30', '24:00', '18:60', '1830', '18:3']) {
      expect(checkNote(draft({ startTime: bad, endTime: '23:00' }), TODAY)).toEqual({ messages: { startTime: NOTE_COPY.time } });
      expect(checkNote(draft({ startTime: '00:00', endTime: bad }), TODAY)).toEqual({ messages: { endTime: NOTE_COPY.time } });
    }
    // Start before end, on the same day.
    expect(checkNote(draft({ startTime: '21:00', endTime: '18:00' }), TODAY)).toEqual({ messages: { endTime: NOTE_COPY.timeOrder } });
    expect(checkNote(draft({ startTime: '18:00', endTime: '18:00' }), TODAY)).toEqual({ messages: { endTime: NOTE_COPY.timeOrder } });
    // A closure has no hours: the form hides them, so whatever was typed before is dropped, as guests are on Closed.
    expect(checkNote(draft({ kind: 'closure', effect: 'closed', startTime: '18:00', endTime: 'late' }), TODAY))
      .toMatchObject({ input: { kind: 'closure', startTime: null, endTime: null } });
    expect(NOTE_COPY.time).toBe('Enter a time as HH:MM, for example 18:30.');
    expect(NOTE_COPY.timeOrder).toBe('The end time is before the start time.');
    expect(NOTE_COPY.timePair).toBe('Enter both times, or neither.');
  });

  test('checkNote: a buyout keeps its expected guests', () => {
    expect(checkNote(draft({ effect: 'closed', expectedGuests: '70' }), TODAY)).toMatchObject({ input: { kind: 'private_event', effect: 'closed', expectedGuests: 70 } });
    expect(checkNote(draft({ effect: 'closed', expectedGuests: '0' }), TODAY)).toEqual({ messages: { expectedGuests: NOTE_COPY.guests } });
    expect(checkNote(draft({ effect: 'closed', expectedGuests: '' }), TODAY)).toMatchObject({ input: { expectedGuests: null } });
    // Any other closed note still sends none.
    for (const kind of ['closure', 'opening', 'other'] as const) {
      expect(checkNote(draft({ kind, effect: 'closed', expectedGuests: '70', detail: 'x' }), TODAY)).toMatchObject({ input: { expectedGuests: null } });
    }
  });

  test('a note’s hours read back into the form, and the form gives them back; a note from before hours reads as all day', () => {
    const note = noteOf('n1', {
      kind: 'private_event', startDate: '2027-03-01', endDate: '2027-03-01', effect: 'more_guests', expectedGuests: 70, startTime: '18:00', endTime: '21:00',
    });
    expect(draftOf(note)).toMatchObject({ startTime: '18:00', endTime: '21:00' });
    expect(checkNote(draftOf(note), TODAY)).toMatchObject({ input: { startTime: '18:00', endTime: '21:00', expectedGuests: 70 } });
    // A TownwiseAI proposal carries no hours.
    const proposal = { kind: 'closure', startDate: '2027-03-01', endDate: '2027-03-01', weekdays: null, effect: 'closed', expectedGuests: null, detail: null } as const;
    expect(draftOfContent(proposal)).toMatchObject({ startTime: '', endTime: '' });
    expect(emptyDraft()).toMatchObject({ startTime: '', endTime: '' });
  });

  test('the note schema reads missing hours, from an API before them, as none', () => {
    const old: Record<string, unknown> = { ...noteOf('n1') };
    delete old.startTime;
    delete old.endTime;
    const parsed = noteSchema.parse(old);
    expect(parsed.startTime ?? null).toBeNull();
    expect(hoursLine(parsed)).toBeNull();
    expect(noteSchema.parse({ ...old, startTime: '18:00', endTime: '21:00' })).toMatchObject({ startTime: '18:00', endTime: '21:00' });
  });

  test('the note schema reads a missing source, from an API before it, and keeps a TownwiseAI file source (D34)', () => {
    const old: Record<string, unknown> = { ...noteOf('n1') };
    delete old.source;
    expect(noteSchema.parse(old).source ?? null).toBeNull();
    expect(noteSchema.parse({ ...old, source: null }).source).toBeNull();
    expect(noteSchema.parse({ ...old, source: { via: 'ai_file', fileId: 'file-1' } }).source).toEqual({ via: 'ai_file', fileId: 'file-1' });
  });

  test('draftOfImported: a private event with the calendar event’s dates and hours, and never its title', () => {
    const dinner = { uid: 'i1', title: 'Smith rehearsal dinner', startDate: '2026-12-24', endDate: '2026-12-24', startTime: '18:00', endTime: '21:00' };
    expect(draftOfImported(dinner)).toEqual({
      ...emptyDraft('private_event'), effect: 'more_guests', startDate: '2026-12-24', endDate: '', startTime: '18:00', endTime: '21:00', detail: '',
    });
    expect(JSON.stringify(draftOfImported(dinner))).not.toContain('Smith');
    expect(checkNote(draftOfImported(dinner), TODAY)).toMatchObject({ input: { startDate: '2026-12-24', endDate: '2026-12-24', startTime: '18:00', endTime: '21:00', detail: null } });
    const away = { uid: 'i2', title: 'Owner away', startDate: '2026-12-24', endDate: '2026-12-26', startTime: null, endTime: null };
    expect(draftOfImported(away)).toMatchObject({ startDate: '2026-12-24', endDate: '2026-12-26', startTime: '', endTime: '' });
  });

  test('draftOfImported: an event that runs past midnight is a note on its start day only, without hours the form refuses', () => {
    // parseIcs keeps an event ending by 06:00 the next morning on its start day, its end earlier than its start.
    const late = { uid: 'i3', title: 'Late party', startDate: '2026-12-24', endDate: '2026-12-24', startTime: '18:00', endTime: '01:00' };
    expect(draftOfImported(late)).toMatchObject({ startDate: '2026-12-24', endDate: '', startTime: '', endTime: '' });
    expect(checkNote(draftOfImported(late), TODAY)).toMatchObject({ input: { startDate: '2026-12-24', endDate: '2026-12-24', startTime: null, endTime: null } });
  });
});

describe('hours and buyouts in words', () => {
  test('clockWords: 18:30 is 6:30 pm, 12:00 is noon, 00:15 is 12:15 am', () => {
    expect(clockWords('18:30')).toBe('6:30 pm');
    expect(clockWords('18:00')).toBe('6 pm');
    expect(clockWords('12:00')).toBe('noon');
    expect(clockWords('12:30')).toBe('12:30 pm');
    expect(clockWords('00:00')).toBe('midnight');
    expect(clockWords('00:15')).toBe('12:15 am');
    expect(clockWords('09:05')).toBe('9:05 am');
  });

  test('hoursLine gives “6 pm to 9 pm”, or null for all day', () => {
    expect(hoursLine({ startTime: '18:00', endTime: '21:00' })).toBe('6 pm to 9 pm');
    expect(hoursLine({ startTime: '11:30', endTime: '12:00' })).toBe('11:30 am to noon');
    expect(hoursLine({ startTime: null, endTime: null })).toBeNull();
    expect(hoursLine({})).toBeNull();
  });

  test('a private event that closes the day reads Private buyout', () => {
    expect(noteWords({ kind: 'private_event', effect: 'closed' })).toBe('Private buyout');
    expect(noteWords({ kind: 'private_event', effect: 'more_guests' })).toBe('Private event, more guests than usual');
    expect(noteWords({ kind: 'closure', effect: 'closed' })).toBe('Closure');
  });
});
