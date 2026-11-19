import {
  askDraft, BANNER_DISMISS, BANNER_LINK, bannerWords, EDIT_SHEET, EDITED_LINE, FOUND_ACTIONS, FOUND_LABEL, FOUND_NOTE, FOUND_NOTICES, foundActionLabel,
  foundChips, foundEntryLabel, foundLine, foundTime, foundWords, whereWho,
} from '../../src/portal/research/copy';
import * as copy from '../../src/portal/research/copy';

// D66 (town-research-agent) task 7.5, the Calendar's part: every sentence the Calendar says about town research,
// pinned (design decision 15). Research works in "topics", never "threads", and no sentence has an em dash.

const COUNTS = { found: 0, added: 0, updated: 0, dropped: 0 };

test('the filter, the group and its note', () => {
  expect(FOUND_LABEL).toBe('Found by research');
  expect(FOUND_NOTE).toBe('Found by Townwise’s research on public websites. A change here applies to this location only. They change the forecast only through a note you add or accept.');
  expect(foundEntryLabel('Trivia night')).toBe('Found by research: Trivia night');
});

test('a found event’s line, where and who, chips and compact words', () => {
  expect(foundLine({ start: '2026-12-03', end: '2026-12-03', weekdays: null, startTime: '19:00' })).toBe('Dec 3, 2026, from 7 pm');
  expect(foundLine({ start: '2026-12-01', end: '2026-12-14', weekdays: [4], startTime: null })).toBe('Dec 1, 2026 to Dec 14, 2026, Thursdays only');
  expect(foundTime({ startTime: '12:00' })).toBe('From noon');
  expect(foundTime({ startTime: null })).toBeNull();
  expect(whereWho({ where: 'Example Hall', who: 'Example Club' })).toBe('at Example Hall · by Example Club');
  expect(whereWho({ where: 'Example Hall', who: null })).toBe('at Example Hall');
  expect(whereWho({ where: null, who: 'Example Club' })).toBe('by Example Club');
  expect(whereWho({ where: null, who: null })).toBeNull();
  expect(foundChips({ confidence: 'low', status: 'cancelled' })).toEqual(['Unconfirmed', 'Cancelled']);
  expect(foundChips({ confidence: 'medium', status: 'postponed' })).toEqual([]);
  expect(foundWords({ title: 'Trivia night', status: 'cancelled' })).toBe('Trivia night (cancelled)');
  expect(foundWords({ title: 'Trivia night', status: 'scheduled' })).toBe('Trivia night');
});

test('the actions, their screen-reader names and their answers', () => {
  expect(FOUND_ACTIONS).toEqual({ edit: 'Edit', hide: 'Hide', ask: 'Ask TownwiseAI', reset: 'Reset' });
  expect(EDITED_LINE).toBe('Edited by your team');
  expect(foundActionLabel('edit', 'Trivia night')).toBe('Edit Trivia night');
  expect(foundActionLabel('ask', 'Trivia night')).toBe('Ask TownwiseAI about Trivia night');
  expect(FOUND_NOTICES).toEqual({
    saved: 'Saved. Only this location’s calendar changes.',
    hidden: 'Hidden for this location. Restore it from the Town tab.',
    reset: 'Back to what research found.',
    changedSince: 'Someone changed this event since you opened it. It now reads as shown. Save again to apply your change.',
    changedSinceAction: 'Someone changed this event since you opened it. Here is how it reads now.',
    gone: 'This event isn’t available any more.',
    tooManyEdits: 'This location has reached its limit of 1,000 edits to researched events.',
    invalid: 'Check the title, dates and time.',
  });
  expect(EDIT_SHEET).toEqual({
    heading: 'Edit event', title: 'Title', start: 'Starts', end: 'Ends', time: 'Time (optional)', where: 'Where (optional)', save: 'Save',
    saving: 'Saving…', cancel: 'Cancel', needTitle: 'Enter a title.', badDate: 'Enter a date as YYYY-MM-DD.',
    endBeforeStart: 'The end can’t be before the start.', badTime: 'Enter a time as HH:MM, or leave it empty.',
  });
});

test('Ask TownwiseAI’s draft names the title and the day, with the year only when it isn’t this year', () => {
  expect(askDraft('Trivia night', '2026-12-03', '2026-11-19')).toBe('Is Trivia night on Thu, Dec 3 right?');
  expect(askDraft('Winter carnival', '2027-02-12', '2026-11-19')).toBe('Is Winter carnival on Fri, Feb 12, 2027 right?');
});

test('the banner: only a run a person started, while it runs and after, in plain words', () => {
  expect(bannerWords(null, 'Main Street Bar')).toBeNull();
  expect(bannerWords({ trigger: 'weekly', status: 'running', counts: COUNTS }, 'Main Street Bar')).toBeNull();
  for (const status of ['queued', 'running', 'merging'] as const) {
    expect(bannerWords({ trigger: 'press', status, counts: COUNTS }, 'Main Street Bar'))
      .toBe('Researching Main Street Bar and its town. What it finds shows on the calendar when it finishes.');
  }
  expect(bannerWords({ trigger: 'early', status: 'done', counts: { ...COUNTS, added: 1 } }, 'Main Street Bar'))
    .toBe('Research for Main Street Bar finished: 1 new event on the calendar.');
  expect(bannerWords({ trigger: 'press', status: 'done', counts: COUNTS }, 'Main Street Bar'))
    .toBe('Research for Main Street Bar finished: nothing new this time.');
  expect(bannerWords({ trigger: 'press', status: 'partial', counts: { ...COUNTS, added: 4 } }, 'Main Street Bar'))
    .toBe('Research for Main Street Bar finished with some topics left undone: 4 new events on the calendar.');
  for (const status of ['failed', 'budget', 'off'] as const) {
    expect(bannerWords({ trigger: 'press', status, counts: COUNTS }, 'Main Street Bar')).toBe('Research for Main Street Bar didn’t finish. The Town tab says why.');
  }
  expect(BANNER_LINK).toBe('Open the Town tab');
  expect(BANNER_DISMISS).toBe('Dismiss');
});

test('no word says “thread”, and none has an em dash', () => {
  const strings: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect);
  };
  collect(Object.values(copy).filter((value) => typeof value !== 'function'));
  strings.push(
    bannerWords({ trigger: 'press', status: 'partial', counts: COUNTS }, 'X') ?? '', bannerWords({ trigger: 'press', status: 'failed', counts: COUNTS }, 'X') ?? '',
    bannerWords({ trigger: 'press', status: 'running', counts: COUNTS }, 'X') ?? '',
  );
  for (const words of strings) {
    expect(words).not.toMatch(/thread/i);
    expect(words).not.toContain('—');
  }
});
