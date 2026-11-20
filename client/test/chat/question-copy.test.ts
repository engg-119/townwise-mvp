import type { ActivityItem, Question } from '../../src/chat/api';
import { activityLine } from '../../src/chat/ui/AgentSidePanel';
import { answeredLine, otherMaxLength, otherMessage, questionCopy } from '../../src/chat/ui/QuestionCard';
import type { Note } from '../../src/portal/locations/api';

// TownwiseAI's questions in words (contract section 7; spec P25, 10.12): each kind's heading, the evidence it
// shows, its four answers and their help, the line once answered, the message Something else… sends to the chat, and
// the activity lines. The words are the client's; the API sends ids, dates and counts.

const LOCATION = 'Main Street Bar';

// Mon, Oct 19, 2026.
const ONE_DAY: Question = {
  id: 'gap_2026-10-19_2026-10-19', kind: 'gap', from: '2026-10-19', to: '2026-10-19', dayCount: 1, typicalGuestsLow: 95, typicalGuestsHigh: 95,
};
const TWO_DAYS: Question = {
  id: 'gap_2026-05-12_2026-05-13', kind: 'gap', from: '2026-05-12', to: '2026-05-13', dayCount: 2, typicalGuestsLow: 80, typicalGuestsHigh: 120,
};
const TWO_DAYS_EVEN: Question = { ...TWO_DAYS, typicalGuestsLow: 100, typicalGuestsHigh: 100 };
// Sat, May 23, 2026.
function likely(guests: number): Extract<Question, { kind: 'likely_closed' }> {
  return { id: 'likely_closed_2026-05-23', kind: 'likely_closed', date: '2026-05-23', guests, typicalGuests: 100 };
}

function noteOf(content: Partial<Note>): Note {
  return {
    id: 'n1', kind: 'closure', startDate: '2026-05-23', endDate: '2026-05-23', weekdays: null, effect: 'closed', expectedGuests: null,
    detail: null, startTime: null, endTime: null, createdByEmail: 'owner', createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z', canEdit: true, ...content,
  };
}

function labels(question: Question, chat = true): string[] {
  return questionCopy(question, LOCATION, chat).answers.map((answer) => `${answer.value}: ${answer.label}`);
}

describe('each kind’s card', () => {
  test('a one-day gap weighs the day against its weekday’s usual guests', () => {
    const copy = questionCopy(ONE_DAY, LOCATION, true);
    expect(copy.heading).toBe('Were you closed on Mon, Oct 19, 2026?');
    expect(copy.context).toBe('Mondays usually have about 95 guests. Mon, Oct 19 has no sales.');
    expect(labels(ONE_DAY)).toEqual(['closed: Yes, we were closed', 'open: No, the data is missing', 'not_sure: Not sure', 'other: Something else…']);
    expect(copy.help).toBe('Yes saves a closure note for that day. If the data is missing, upload that day and TownwiseAI will use it. Something else lets you tell TownwiseAI in the chat.');
  });

  test('a gap of several days gives the range of usual guests, or one figure when it is one', () => {
    const copy = questionCopy(TWO_DAYS, LOCATION, true);
    expect(copy.heading).toBe('Were you closed May 12 to May 13, 2026?');
    expect(copy.context).toBe('There are no sales for these 2 days. You usually have about 80 to 120 guests on those days of the week.');
    expect(questionCopy(TWO_DAYS_EVEN, LOCATION, true).context).toBe('There are no sales for these 2 days. You usually have about 100 guests on those days of the week.');
    expect(labels(TWO_DAYS)).toEqual(['closed: Yes, we were closed', 'open: No, the data is missing', 'not_sure: Not sure', 'other: Something else…']);
    expect(copy.help).toBe('Yes saves a closure note for those days. If the data is missing, upload those days and TownwiseAI will use them. Something else lets you tell TownwiseAI in the chat.');
  });

  test('a likely-closed day says how few guests were recorded, and asks whether it was open', () => {
    const copy = questionCopy(likely(1), LOCATION, true);
    expect(copy.heading).toBe('Were you open on Sat, May 23, 2026?');
    expect(copy.context).toBe('Only 1 guest was recorded. Saturdays usually have about 100.');
    expect(questionCopy(likely(2), LOCATION, true).context).toBe('Only 2 guests were recorded. Saturdays usually have about 100.');
    expect(questionCopy(likely(0), LOCATION, true).context).toBe('No guests were recorded, only sales. Saturdays usually have about 100 guests.');
    // Yes is open here, so it comes first.
    expect(labels(likely(1))).toEqual(['open: Yes, it was just slow', 'closed: No, we were closed', 'not_sure: Not sure', 'other: Something else…']);
    expect(copy.help).toBe('Townwise treats this day as likely closed until you say. Yes saves a note that you were open with fewer guests, so the day counts. No saves a closure note for it. Something else lets you tell TownwiseAI in the chat.');
  });

  test('a gap from an API without its usual guests says only that there are no sales, and claims no “usually”', () => {
    const older: Question = { id: 'gap_2026-05-12_2026-05-13', kind: 'gap', from: '2026-05-12', to: '2026-05-13', dayCount: 2 };
    expect(questionCopy(older, LOCATION, true).context).toBe('There are no sales for these 2 days.');
    expect(otherMessage(older, 'Renovation.')).toBe('About May 12 to May 13, 2026 (no sales on these 2 days): Renovation.');
    const olderDay: Question = { id: 'gap_2026-10-19_2026-10-19', kind: 'gap', from: '2026-10-19', to: '2026-10-19', dayCount: 1 };
    expect(questionCopy(olderDay, LOCATION, true).context).toBe('There are no sales for this day.');
    expect(otherMessage(olderDay, 'Renovation.')).toBe('About Mon, Oct 19, 2026 (no sales): Renovation.');
  });

  test('counts read with thousands separators', () => {
    expect(questionCopy({ ...likely(1), typicalGuests: 1200 }, LOCATION, true).context).toBe('Only 1 guest was recorded. Saturdays usually have about 1,200.');
  });

  test('with TownwiseAI’s chat off there is no Something else…, and the help doesn’t offer it', () => {
    for (const question of [ONE_DAY, TWO_DAYS, likely(1)]) {
      const copy = questionCopy(question, LOCATION, false);
      expect(copy.answers.map((answer) => answer.value)).not.toContain('other');
      expect(copy.answers).toHaveLength(3);
      expect(copy.help).not.toMatch(/Something else/);
    }
    expect(questionCopy(likely(1), LOCATION, false).help).toBe('Townwise treats this day as likely closed until you say. Yes saves a note that you were open with fewer guests, so the day counts. No saves a closure note for it.');
  });
});

describe('the line once answered (the stored answer’s)', () => {
  test('closed shows the closure note it saved, or says so without one', () => {
    const weekdayNote = noteOf({ startDate: '2025-11-03', endDate: '2026-11-02', weekdays: [1] });
    expect(answeredLine(TWO_DAYS, { answer: 'closed', note: weekdayNote })).toBe('Saved a note: Closure, Mondays, Nov 3, 2025 to Nov 2, 2026. TownwiseAI treats those days as closed.');
    expect(answeredLine(likely(1), { answer: 'closed', note: noteOf({}) })).toBe('Saved a note: Closure, Sat, May 23, 2026. TownwiseAI treats that day as closed.');
    expect(answeredLine(TWO_DAYS, { answer: 'closed', note: null })).toBe('Saved. TownwiseAI treats those days as closed.');
  });

  test('open on a likely-closed day shows the open-day note, and Townwise counts the day', () => {
    const openDay = noteOf({ kind: 'other', effect: 'fewer_guests', detail: 'Open, with very few guests (your answer to TownwiseAI).' });
    expect(answeredLine(likely(1), { answer: 'open', note: openDay })).toBe('Saved a note: you were open on Sat, May 23, 2026, with fewer guests than usual. Townwise now counts that day.');
    expect(answeredLine(likely(1), { answer: 'open', note: null })).toBe('Saved. Townwise now counts that day.');
  });

  test('an answer that saves nothing says the question won’t come back', () => {
    for (const question of [ONE_DAY, TWO_DAYS]) {
      expect(answeredLine(question, { answer: 'open', note: null })).toBe('Got it. TownwiseAI won’t ask about these days again.');
      expect(answeredLine(question, { answer: 'not_sure', note: null })).toBe('Got it. TownwiseAI won’t ask about these days again.');
      expect(answeredLine(question, { answer: 'other', note: null })).toBe('Sent to TownwiseAI in the chat. It won’t ask about these days again.');
    }
    expect(answeredLine(likely(1), { answer: 'not_sure', note: null })).toBe('Got it. TownwiseAI won’t ask about this day again.');
    expect(answeredLine(likely(1), { answer: 'other', note: null })).toBe('Sent to TownwiseAI in the chat. It won’t ask about this day again.');
  });
});

describe('Something else…’s message', () => {
  test('is the question and its evidence, then the person’s words, trimmed', () => {
    expect(otherMessage(ONE_DAY, '  We closed early for a burst pipe and the export missed the day.\n'))
      .toBe('About Mon, Oct 19, 2026 (no sales; Mondays usually have about 95 guests): We closed early for a burst pipe and the export missed the day.');
    expect(otherMessage(TWO_DAYS, 'Renovation.'))
      .toBe('About May 12 to May 13, 2026 (no sales on these 2 days; those days of the week usually have about 80 to 120 guests): Renovation.');
    expect(otherMessage(TWO_DAYS_EVEN, 'Renovation.'))
      .toBe('About May 12 to May 13, 2026 (no sales on these 2 days; those days of the week usually have about 100 guests): Renovation.');
    expect(otherMessage(likely(1), 'A storm.')).toBe('About Sat, May 23, 2026 (only 1 guest recorded; Saturdays usually have about 100): A storm.');
    expect(otherMessage(likely(2), 'A storm.')).toBe('About Sat, May 23, 2026 (only 2 guests recorded; Saturdays usually have about 100): A storm.');
    expect(otherMessage(likely(0), 'A storm.')).toBe('About Sat, May 23, 2026 (sales but no guests recorded; Saturdays usually have about 100): A storm.');
  });

  test('the field holds at most what fits in a chat message (4,000 characters) after that prefix', () => {
    for (const question of [ONE_DAY, TWO_DAYS, likely(0)]) {
      const longest = 'x'.repeat(otherMaxLength(question));
      expect(otherMessage(question, longest)).toHaveLength(4000);
    }
  });
});

describe('activity', () => {
  test('Something else… reads as told in the chat; a likely-closed id names its day', () => {
    const answered = (questionId: string, answer: 'open' | 'not_sure' | 'other'): ActivityItem => ({
      at: '2026-06-01T07:00:00.000Z', kind: 'question_answered', questionId, answer,
    });
    expect(activityLine(answered('gap_2026-01-20_2026-01-21', 'other'))).toBe('You told TownwiseAI about Jan 20 to Jan 21, 2026 in the chat.');
    expect(activityLine(answered('weekday_1_2026-03-01_2026-05-31', 'other'))).toBe('You told TownwiseAI about Mondays in the chat.');
    expect(activityLine(answered('likely_closed_2026-05-23', 'other'))).toBe('You told TownwiseAI about Sat, May 23, 2026 in the chat.');
    expect(activityLine(answered('likely_closed_2026-05-23', 'not_sure'))).toBe('You weren’t sure about Sat, May 23, 2026.');
    expect(activityLine(answered('later_1', 'other'))).toBe('You answered a question in the chat.');
  });

  test('D65: a finished forecast run reads as what happened to it, never with a figure', () => {
    const item: ActivityItem = {
      at: '2026-06-01T08:15:00.000Z', kind: 'forecast_made', calibrationId: '0000000000000000000000e7', causes: ['sales'], outcome: 'kept',
      reason: 'not_beat_average', firstForecast: true, dayCount: 412, firstDate: '2025-03-01', lastDate: '2026-05-31', newDays: null,
    };
    expect(activityLine(item)).toBe('Not published: it wasn’t more accurate than a simple weekday average.');
    expect(activityLine({ ...item, outcome: 'not_run', reason: 'failed', firstForecast: false })).toBe('Couldn’t run. Your forecast didn’t change.');
  });
});

// D71: a past private event's guests. Sat, Apr 4, 2026; and Fridays and Saturdays from Apr 3 to Apr 25, 2026.
const PARTY: Question = {
  id: 'party_guests_0000000000000000000000a5', kind: 'party_guests', noteId: '0000000000000000000000a5', startDate: '2026-04-04',
  endDate: '2026-04-04', weekdays: null,
};
const RECURRING: Question = { ...PARTY, startDate: '2026-04-03', endDate: '2026-04-25', weekdays: [5, 6] };

describe('a private event’s guests (D71)', () => {
  test('asks how many guests came that day, or each day of a note over several, with Skip and never Something else…', () => {
    const one = questionCopy(PARTY, LOCATION, true);
    expect(one.heading).toBe('How many guests came for the private event on Sat, Apr 4, 2026?');
    expect(one.context).toBe('Its note has no guest count yet.');
    expect(one.help).toBe('Townwise takes these guests off that day when it learns from your sales, so the event isn’t read as a normal busy day.');
    expect(labels(PARTY)).toEqual(['not_sure: Skip']);
    const many = questionCopy(RECURRING, LOCATION, true);
    expect(many.heading).toBe('How many guests came for the private event each day from Apr 3 to Apr 25, 2026?');
    expect(many.context).toBe('On Fridays and Saturdays only. Its note has no guest count yet.');
    expect(many.help).toBe('Townwise takes these guests off each of those days when it learns from your sales, so the event isn’t read as a normal busy day.');
    expect(questionCopy({ ...RECURRING, weekdays: null }, LOCATION, false).context).toBe('Its note has no guest count yet.');
  });

  test('once answered: the count saved on the note, or that it won’t ask again', () => {
    const saved = (expectedGuests: number) => noteOf({ kind: 'private_event', effect: 'more_guests', startDate: '2026-04-04', endDate: '2026-04-04', expectedGuests });
    expect(answeredLine(PARTY, { answer: 'guests', note: saved(43) })).toBe('Saved: 43 guests on the private event note.');
    expect(answeredLine(PARTY, { answer: 'guests', note: saved(1) })).toBe('Saved: 1 guest on the private event note.');
    expect(answeredLine(PARTY, { answer: 'guests', note: saved(1200) })).toBe('Saved: 1,200 guests on the private event note.');
    expect(answeredLine(RECURRING, { answer: 'guests', note: saved(30) })).toBe('Saved: 30 guests each day on the private event note.');
    expect(answeredLine(PARTY, { answer: 'guests', note: null })).toBe('Saved the guest count on the private event note.');
    expect(answeredLine(PARTY, { answer: 'not_sure', note: null })).toBe('Got it. TownwiseAI won’t ask about this event again.');
  });

  test('a count that lost to one saved first elsewhere, or to a Skip, says it wasn’t used', () => {
    const saved = (expectedGuests: number) => noteOf({ kind: 'private_event', effect: 'more_guests', startDate: '2026-04-03', endDate: '2026-04-25', expectedGuests });
    expect(answeredLine(PARTY, { answer: 'guests', note: saved(30), sent: 50 }))
      .toBe('A count was already saved: 30 guests on the private event note, so your 50 wasn’t used. You can change it on the Notes page.');
    expect(answeredLine(RECURRING, { answer: 'guests', note: saved(30), sent: 1200 }))
      .toBe('A count was already saved: 30 guests each day on the private event note, so your 1,200 wasn’t used. You can change it on the Notes page.');
    // The same count, saved here or first elsewhere, is simply saved.
    expect(answeredLine(RECURRING, { answer: 'guests', note: saved(30), sent: 30 })).toBe('Saved: 30 guests each day on the private event note.');
    expect(answeredLine(PARTY, { answer: 'guests', note: saved(30), asked: 'not_sure' }))
      .toBe('A count was already saved: 30 guests on the private event note. TownwiseAI won’t ask about this event again.');
    expect(answeredLine(PARTY, { answer: 'not_sure', note: null, asked: 'not_sure' })).toBe('Got it. TownwiseAI won’t ask about this event again.');
    expect(answeredLine(PARTY, { answer: 'not_sure', note: null, sent: 50 }))
      .toBe('This question was already skipped, so your count of 50 wasn’t saved. You can add it to the event’s note on the Notes page.');
  });

  test('the activity says a count was saved, with the event’s dates and no count, and a skip as skipped', () => {
    expect(activityLine({ at: '2026-06-01T06:30:00.000Z', kind: 'guest_count_saved', noteId: 'n1', startDate: '2026-04-11', endDate: '2026-04-11' }))
      .toBe('Saved your guest count for the private event, Apr 11, 2026.');
    expect(activityLine({ at: '2026-06-01T06:30:00.000Z', kind: 'question_answered', questionId: PARTY.id, answer: 'not_sure' }))
      .toBe('You skipped the question about a private event’s guests.');
  });
});
