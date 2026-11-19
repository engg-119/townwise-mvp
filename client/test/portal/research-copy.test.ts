import {
  askDraft, BANNER_DISMISS, BANNER_DISMISS_LABEL, BANNER_LINK, bannerWords, EDIT_SHEET, EDITED_LINE, FOUND_ACTIONS, FOUND_LABEL, FOUND_NOTE, FOUND_NOTICES, foundActionLabel,
  foundChips, foundEntryLabel, foundLine, foundTime, foundWords, whereWho,
} from '../../src/portal/research/copy';
import * as copy from '../../src/portal/research/copy';
import {
  APPLY_NOTICES, CORRECTED_LINE, CORRECTION, CORRECTION_CODES, correctionDoneLine, correctionFieldLines, correctionProposedLine,
  DASHBOARD_RESEARCHING, researchBudgetLine, researchDoneLine, type ResearchDone,
} from '../../src/portal/research/copy';

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
    changedSince: 'Someone changed this event since you opened it. It now reads as shown. Make your change again, then save.',
    changedSinceAction: 'Someone changed this event since you opened it. Here is how it reads now.',
    gone: 'This event isn’t available any more.',
    tooManyEdits: 'This location has reached its limit of 1,000 edits to researched events.',
    invalid: 'Check the title, dates and time.',
    badTitle: 'That title can’t be used. Write it in plain words, without a link, an email or a phone number.',
    badWhere: 'That place can’t be used. Write it in plain words, without a link, an email or a phone number.',
    badDates: 'Those dates can’t be used for this event. Check the start and the end.',
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
      .toBe('Researching Main Street Bar and nearby. What it finds shows on the calendar when it finishes.');
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
  expect(BANNER_DISMISS_LABEL).toBe('Dismiss the research notice');
});

describe('TownwiseAI, Home and the dashboard (task 7.4)', () => {
  const RUN: ResearchDone = { subject: 'town', status: 'done', found: 12, added: 4, competitors: null, threadsFailed: 0 };

  test('the correction card: what TownwiseAI did, what it proposes, and the change in plain words', () => {
    expect(CORRECTION).toEqual({
      eyebrow: 'Calendar correction', undo: 'Undo', undoing: 'Undoing…', undone: 'Undone. The event reads as it did before.',
      apply: 'Apply', applying: 'Applying…', applied: 'Applied. Only this location’s calendar changed. Reset it on the Calendar to undo.',
      why: 'This conversation read a web page or a file, so nothing changes until you apply it. It changes this location’s calendar only.',
      open: 'Open the Calendar',
    });
    expect(correctionDoneLine('edit')).toBe('TownwiseAI changed an event town research found, on this location’s calendar only.');
    expect(correctionDoneLine('hide')).toBe('TownwiseAI hid an event town research found, on this location’s calendar only.');
    expect(correctionDoneLine('restore')).toBe('TownwiseAI restored an event town research found, on this location’s calendar only.');
    expect(correctionProposedLine('edit')).toBe('TownwiseAI suggests changing an event town research found.');
    expect(correctionProposedLine('hide')).toBe('TownwiseAI suggests hiding an event town research found.');
    expect(correctionProposedLine('restore')).toBe('TownwiseAI suggests restoring an event town research found.');
    expect(correctionFieldLines({ title: 'Quiz night', start: '2026-12-10', end: '2026-12-10', weekdays: [4], startTime: '19:30', where: 'Example Hall' }))
      .toEqual(['Title: Quiz night', 'Dates: Dec 10, 2026', 'Thursdays only', 'From 7:30 pm', 'Where: Example Hall']);
    expect(correctionFieldLines({ start: '2026-12-10' })).toEqual(['Starts Dec 10, 2026']);
    expect(correctionFieldLines({ end: '2026-12-12', weekdays: null, startTime: null, where: null }))
      .toEqual(['Ends Dec 12, 2026', 'Every day of its dates', 'No start time', 'No place']);
    expect(correctionFieldLines(null)).toEqual([]);
    expect(APPLY_NOTICES).toEqual({
      changedSince: 'Someone changed this event just now. Check it on the Calendar, then apply again if it’s still right.',
      gone: 'This event isn’t available any more.',
      tooManyEdits: 'This location has reached its limit of 1,000 edits to researched events.',
      invalid: 'This change can’t be applied as it is now. Make it on the Calendar instead.',
      viewAs: 'View-as is read-only, so you can’t apply this.',
      failed: 'Couldn’t apply this. Try again.',
    });
    // Every code the API's tool answers (api/src/chat/tools/correct-calendar-event.ts CorrectionCode) but needs_tap, which is a card.
    expect(Object.keys(CORRECTION_CODES).sort()).toEqual([
      'bad_dates', 'bad_title', 'changed_since', 'duplicate', 'invalid', 'not_found', 'not_researched', 'staff', 'too_many', 'too_many_edits', 'view_as',
    ]);
    expect(CORRECTED_LINE).toBe('Corrected an event town research found, on this location’s calendar only, from your message.');
  });

  test('the activity’s research_done line, the town’s by name and the location’s as your restaurant and nearby', () => {
    expect(researchDoneLine(RUN, 'Hanover')).toBe('Researched Hanover: 12 events found, 4 new.');
    expect(researchDoneLine({ ...RUN, subject: 'location', found: 9, added: 3, competitors: 2 }, 'Hanover'))
      .toBe('Researched your restaurant and nearby: 9 events found, 3 new, 2 of them at competitors.');
    expect(researchDoneLine({ ...RUN, subject: 'location', found: 1, added: 0, competitors: 0 }, 'Hanover'))
      .toBe('Researched your restaurant and nearby: 1 event found, none new.');
    expect(researchDoneLine({ ...RUN, found: 0, added: 0 }, 'Hanover')).toBe('Researched Hanover: nothing found this time.');
    expect(researchDoneLine({ ...RUN, status: 'partial', threadsFailed: 2 }, 'Hanover')).toBe('Researched Hanover: 12 events found, 4 new. 2 topics didn’t finish.');
    expect(researchDoneLine({ ...RUN, status: 'partial', threadsFailed: 1 }, 'Hanover')).toBe('Researched Hanover: 12 events found, 4 new. 1 topic didn’t finish.');
    expect(researchDoneLine({ ...RUN, status: 'failed' }, 'Hanover')).toBe('Research of Hanover didn’t finish. Nothing changed on the calendar.');
    expect(researchDoneLine({ ...RUN, status: 'budget' }, 'Hanover')).toBe('Research of Hanover waited: Townwise’s research budget for this month is used.');
    expect(researchDoneLine({ ...RUN, subject: 'location', status: 'budget', competitors: 0 }, 'Hanover'))
      .toBe('Research of your restaurant and nearby didn’t run: little of this month’s TownwiseAI budget was left.');
  });

  test('the budget’s research line in dollars, only when research spent something; the dashboard’s word', () => {
    expect(researchBudgetLine(3.5)).toBe('Research used $3.50 of this month’s budget.');
    expect(researchBudgetLine(0)).toBeNull();
    expect(researchBudgetLine(undefined)).toBeNull();
    expect(DASHBOARD_RESEARCHING).toBe('Researching');
  });
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
    ...(['edit', 'hide', 'restore'] as const).flatMap((change) => [correctionDoneLine(change), correctionProposedLine(change)]),
    ...(['town', 'location'] as const).flatMap((subject) => (['done', 'partial', 'failed', 'budget'] as const).map((status) => researchDoneLine({
      subject, status, found: 3, added: 2, competitors: 1, threadsFailed: 1,
    }, 'X'))),
    researchBudgetLine(1) ?? '',
  );
  for (const words of strings) {
    expect(words).not.toMatch(/thread/i);
    expect(words).not.toContain('—');
  }
});
