import type { ActivityItem, Question } from '../../src/chat/api';
import { activityLine } from '../../src/chat/ui/AgentSidePanel';
import { answeredLine, otherMaxLength, otherMessage, questionCopy } from '../../src/chat/ui/QuestionCard';
import type { Note } from '../../src/portal/locations/api';

// TownwiseAI's questions in words (contract section 7; spec P25, 10.12): each kind's heading, the evidence it
// shows, its four answers and their help, the line once answered, the message Something else… sends to the chat, and
// the activity lines. The words are the client's; the API sends ids, dates and counts.

const LOCATION = 'Main Street Bar';

const WEEKDAY: Question = {
  id: 'weekday_1_2025-11-03_2026-11-02', kind: 'weekday', weekday: 1, from: '2025-11-03', to: '2026-11-02', noSalesCount: 41, weekdayCount: 52,
};
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
  test('a weekday says the counts, never “usually”', () => {
    const copy = questionCopy(WEEKDAY, LOCATION, true);
    expect(copy.heading).toBe('Are you closed on Mondays?');
    expect(copy.context).toBe('Main Street Bar has no sales on 41 of the 52 Mondays in weeks with sales on other days.');
    expect(labels(WEEKDAY)).toEqual(['closed: Yes, closed Mondays', 'open: No, the data is missing', 'not_sure: Not sure', 'other: Something else…']);
    expect(copy.help).toBe('Yes saves a closure note for Mondays from Nov 3, 2025 to Nov 2, 2026. Something else lets you tell TownwiseAI in the chat. Any answer stops this question.');
  });

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
    for (const question of [WEEKDAY, ONE_DAY, TWO_DAYS, likely(1)]) {
      const copy = questionCopy(question, LOCATION, false);
      expect(copy.answers.map((answer) => answer.value)).not.toContain('other');
      expect(copy.answers).toHaveLength(3);
      expect(copy.help).not.toMatch(/Something else/);
    }
    expect(questionCopy(WEEKDAY, LOCATION, false).help).toBe('Yes saves a closure note for Mondays from Nov 3, 2025 to Nov 2, 2026. Any answer stops this question.');
    expect(questionCopy(likely(1), LOCATION, false).help).toBe('Townwise treats this day as likely closed until you say. Yes saves a note that you were open with fewer guests, so the day counts. No saves a closure note for it.');
  });
});

describe('the line once answered (the stored answer’s)', () => {
  test('closed shows the closure note it saved, or says so without one', () => {
    const weekdayNote = noteOf({ startDate: '2025-11-03', endDate: '2026-11-02', weekdays: [1] });
    expect(answeredLine(WEEKDAY, { answer: 'closed', note: weekdayNote })).toBe('Saved a note: Closure, Mondays, Nov 3, 2025 to Nov 2, 2026. TownwiseAI treats those days as closed.');
    expect(answeredLine(likely(1), { answer: 'closed', note: noteOf({}) })).toBe('Saved a note: Closure, Sat, May 23, 2026. TownwiseAI treats that day as closed.');
    expect(answeredLine(TWO_DAYS, { answer: 'closed', note: null })).toBe('Saved. TownwiseAI treats those days as closed.');
  });

  test('open on a likely-closed day shows the open-day note, and Townwise counts the day', () => {
    const openDay = noteOf({ kind: 'other', effect: 'fewer_guests', detail: 'Open, with very few guests (your answer to TownwiseAI).' });
    expect(answeredLine(likely(1), { answer: 'open', note: openDay })).toBe('Saved a note: you were open on Sat, May 23, 2026, with fewer guests than usual. Townwise now counts that day.');
    expect(answeredLine(likely(1), { answer: 'open', note: null })).toBe('Saved. Townwise now counts that day.');
  });

  test('an answer that saves nothing says the question won’t come back', () => {
    for (const question of [WEEKDAY, ONE_DAY, TWO_DAYS]) {
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
    expect(otherMessage(WEEKDAY, 'We open Mondays in summer only.'))
      .toBe('About Mondays from Nov 3, 2025 to Nov 2, 2026 (no sales on 41 of the 52 Mondays in weeks with sales on other days): We open Mondays in summer only.');
    expect(otherMessage(TWO_DAYS, 'Renovation.'))
      .toBe('About May 12 to May 13, 2026 (no sales on these 2 days; those days of the week usually have about 80 to 120 guests): Renovation.');
    expect(otherMessage(TWO_DAYS_EVEN, 'Renovation.'))
      .toBe('About May 12 to May 13, 2026 (no sales on these 2 days; those days of the week usually have about 100 guests): Renovation.');
    expect(otherMessage(likely(1), 'A storm.')).toBe('About Sat, May 23, 2026 (only 1 guest recorded; Saturdays usually have about 100): A storm.');
    expect(otherMessage(likely(2), 'A storm.')).toBe('About Sat, May 23, 2026 (only 2 guests recorded; Saturdays usually have about 100): A storm.');
    expect(otherMessage(likely(0), 'A storm.')).toBe('About Sat, May 23, 2026 (sales but no guests recorded; Saturdays usually have about 100): A storm.');
  });

  test('the field holds at most what fits in a chat message (4,000 characters) after that prefix', () => {
    for (const question of [WEEKDAY, ONE_DAY, TWO_DAYS, likely(0)]) {
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
});
