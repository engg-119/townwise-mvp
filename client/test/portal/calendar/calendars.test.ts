import {
  addedLines, addRefusal, CALENDARS_COPY, labelOfFile, linkProblems, refreshedLine, refreshRefusal, removedLine, rowLines, statusWords,
} from '../../../src/portal/calendar/calendars';
import { COPY } from '../../../src/portal/errors';
import { formatDate, formatTime } from '../../../src/portal/format';
import { offline, refusal } from '../../helpers/portal';
import { ownerCalendar } from './fakes';

// The "Your calendars" panel's words (connect-owner-calendar design decision 11): a file's name, every refusal phase 1
// answers, a link's status, a row's lines and the add-a-link form's checks. Made-up names only.

describe('labelOfFile', () => {
  test('takes a final .ics off in any case and trims', () => {
    expect(labelOfFile('Kitchen bookings.ics')).toBe('Kitchen bookings');
    expect(labelOfFile('Kitchen bookings.ICS')).toBe('Kitchen bookings');
    expect(labelOfFile('Bookings')).toBe('Bookings');
    expect(labelOfFile('  Bar  .ics')).toBe('Bar');
  });

  test('cuts to 60 code units, never splitting a surrogate pair, and trims again', () => {
    expect(labelOfFile(`${'A'.repeat(70)}.ics`)).toBe('A'.repeat(60));
    expect(labelOfFile(`${'B'.repeat(59)}😀${'C'.repeat(10)}.ics`)).toBe('B'.repeat(59));
    expect(labelOfFile(`${'D'.repeat(59)} tail.ics`)).toBe('D'.repeat(59));
  });

  test('a name that is only .ics is “Calendar file”', () => {
    expect(labelOfFile('.ics')).toBe('Calendar file');
    expect(labelOfFile('   .ics')).toBe('Calendar file');
  });
});

describe('addRefusal', () => {
  test('a file’s refusals', () => {
    expect(addRefusal(refusal(400, 'too_large'), 'file', 'web')).toBe('This file is over 1 MB. Export a shorter range of your calendar.');
    expect(addRefusal(refusal(413, null), 'file', 'web')).toBe('This file is over 1 MB. Export a shorter range of your calendar.');
    expect(addRefusal(refusal(400, 'not_calendar'), 'file', 'web')).toBe('This doesn’t look like a calendar file (.ics).');
    expect(addRefusal(refusal(409, 'calendar_limit'), 'file', 'web'))
      .toBe('This location has 5 calendars, the most it can hold. Remove one to add another.');
    expect(addRefusal(refusal(429, 'rate_limited', 120), 'file', 'web')).toBe('Too many attempts. Try again in 2 minutes.');
  });

  test('a link’s refusals', () => {
    const words = (code: string): string => addRefusal(refusal(400, code), 'link', 'web');
    expect(words('bad_link')).toBe('Paste a link that starts with https:// or webcal://.');
    expect(words('blocked_address')).toBe('Townwise doesn’t read calendars from that address. Use the link from your calendar’s settings.');
    expect(words('unreachable')).toBe('Couldn’t reach that link. Check it and try again.');
    expect(words('timeout')).toBe('That link took too long to answer. Try again in a few minutes.');
    expect(words('too_large')).toBe('That calendar is over 1 MB, more than Townwise reads.');
    expect(words('http_error')).toBe('That link answered with an error. Check it and try again.');
    expect(words('not_calendar')).toBe('That link doesn’t lead to a calendar. Use its iCal link, which often ends in .ics.');
    expect(addRefusal(refusal(409, 'calendar_limit'), 'link', 'native'))
      .toBe('This location has 5 calendars, the most it can hold. Remove one to add another.');
    expect(addRefusal(refusal(429, 'rate_limited', 120), 'link', 'web')).toBe('Too many attempts. Try again in 2 minutes.');
    expect(addRefusal(refusal(429, 'rate_limited'), 'link', 'web')).toBe('Too many attempts. Try again in a few minutes.');
  });

  test('links unavailable has its own words on web and on native', () => {
    expect(addRefusal(refusal(503, 'calendar_links_unavailable'), 'link', 'web'))
      .toBe('Calendar links aren’t available right now. You can still import a calendar file.');
    expect(addRefusal(refusal(503, 'calendar_links_unavailable'), 'link', 'native'))
      .toBe('Calendar links aren’t available right now. You can still import a calendar file on the web.');
  });

  test('anything else gets the shared error words', () => {
    expect(addRefusal(offline(), 'file', 'web')).toBe(COPY.network);
    expect(addRefusal(offline(), 'link', 'native')).toBe(COPY.network);
    expect(addRefusal(refusal(400, 'invalid_request'), 'link', 'web')).toBe(COPY.request);
    expect(addRefusal(refusal(503, null), 'link', 'web')).toBe(COPY.unavailable);
  });
});

describe('refreshRefusal', () => {
  test('a refresh within 5 minutes of the last says when to try again', () => {
    expect(refreshRefusal(refusal(429, 'rate_limited', 60))).toBe('This calendar was refreshed a few minutes ago. Try again in 1 minute.');
    expect(refreshRefusal(refusal(429, 'rate_limited', 240))).toBe('This calendar was refreshed a few minutes ago. Try again in 4 minutes.');
    expect(refreshRefusal(refusal(429, 'rate_limited'))).toBe('This calendar was refreshed a few minutes ago. Try again in a few minutes.');
  });

  test('links unavailable, a calendar already removed, and anything else', () => {
    expect(refreshRefusal(refusal(503, 'calendar_links_unavailable')))
      .toBe('Calendar links aren’t available right now. This calendar’s events stay as they are.');
    expect(refreshRefusal(refusal(404, 'not_found'))).toBe('This calendar was already removed.');
    expect(refreshRefusal(offline())).toBe(COPY.network);
  });
});

describe('statusWords', () => {
  test('every failure phase 1 records (CALENDAR_STATUSES, api/src/stores/owner-calendars.ts) has its words', () => {
    expect(statusWords('bad_link')).toBe('Couldn’t refresh: the link now leads to an address that isn’t https.');
    expect(statusWords('blocked_address')).toBe('Couldn’t refresh: the link now leads to an address Townwise doesn’t read.');
    expect(statusWords('unreachable')).toBe('Couldn’t refresh: Townwise couldn’t reach the link.');
    expect(statusWords('timeout')).toBe('Couldn’t refresh: the link took too long to answer.');
    expect(statusWords('too_large')).toBe('Couldn’t refresh: the calendar is over 1 MB.');
    expect(statusWords('http_error')).toBe('Couldn’t refresh: the link answered with an error.');
    expect(statusWords('not_calendar')).toBe('Couldn’t refresh: the link no longer leads to a calendar.');
    expect(statusWords('key_mismatch')).toBe('Townwise can’t open this link any more. Remove it and add the link again.');
  });

  test('ok has none, and a code the client has no words for gets the generic line', () => {
    expect(statusWords('ok')).toBeNull();
    expect(statusWords('gone_quiet')).toBe('Couldn’t refresh this link.');
  });
});

describe('rowLines', () => {
  test('a file: its kind and count, and no Updated line', () => {
    expect(rowLines(ownerCalendar({ kind: 'file', host: null, eventCount: 12 }))).toEqual({ summary: 'File, 12 events', repeating: null, updated: null });
  });

  test('a link: its host and count, and Updated from its last refresh that worked', () => {
    const at = '2026-11-14T20:42:00.000Z';
    expect(rowLines(ownerCalendar({ kind: 'link', host: 'calendar.google.com', eventCount: 1, lastSuccessAt: at, lastAttemptAt: '2026-11-14T21:00:00.000Z' })))
      .toEqual({ summary: 'Link, calendar.google.com, 1 event', repeating: null, updated: `Updated ${formatDate(at)}, ${formatTime(at)}` });
    expect(rowLines(ownerCalendar({ kind: 'link', host: 'calendar.google.com', lastSuccessAt: null })).updated).toBeNull();
  });

  test('the repeating events it left out, for 1 and for 3', () => {
    expect(rowLines(ownerCalendar({ skippedRepeating: 1 })).repeating).toBe('1 repeating event wasn’t imported. Add it as a note with weekdays.');
    expect(rowLines(ownerCalendar({ skippedRepeating: 3 })).repeating).toBe('3 repeating events weren’t imported. Add them as notes with weekdays.');
  });
});

describe('linkProblems', () => {
  const LINK = 'https://calendar.google.com/calendar/ical/example/basic.ics';

  test('a name and a link within the API’s limits have none', () => {
    expect(linkProblems({ name: 'Bookings', link: LINK })).toEqual({});
    expect(linkProblems({ name: 'N'.repeat(60), link: `https://example.com/${'x'.repeat(2028)}` })).toEqual({});
  });

  test('each field’s words: empty or over its limit, counted after trimming as the API counts', () => {
    expect(linkProblems({ name: '   ', link: LINK })).toEqual({ name: CALENDARS_COPY.nameEmpty });
    expect(CALENDARS_COPY.nameEmpty).toBe('Enter a name for the calendar.');
    expect(linkProblems({ name: 'N'.repeat(61), link: LINK })).toEqual({ name: 'Keep the name to 60 characters.' });
    expect(linkProblems({ name: ` ${'N'.repeat(60)} `, link: LINK })).toEqual({});
    expect(linkProblems({ name: 'Bookings', link: ' ' })).toEqual({ link: 'Paste the calendar’s link.' });
    expect(linkProblems({ name: 'Bookings', link: `https://example.com/${'x'.repeat(2029)}` }))
      .toEqual({ link: 'This link is too long. Copy it again from your calendar’s settings.' });
    expect(linkProblems({ name: '', link: '' })).toEqual({ name: 'Enter a name for the calendar.', link: 'Paste the calendar’s link.' });
  });
});

describe('the result messages', () => {
  test('an add names the calendar and its events, with the repeating line when it skipped any', () => {
    expect(addedLines(ownerCalendar({ label: 'kitchen', eventCount: 2, skippedRepeating: 1 })))
      .toEqual(['Added kitchen: 2 events.', '1 repeating event wasn’t imported. Add it as a note with weekdays.']);
    expect(addedLines(ownerCalendar({ label: 'Bookings', eventCount: 1 }))).toEqual(['Added Bookings: 1 event.']);
  });

  test('a refresh and a removal name the calendar', () => {
    expect(refreshedLine('Bookings')).toBe('Refreshed Bookings.');
    expect(removedLine('Kitchen')).toBe('Removed Kitchen.');
  });
});

describe('CALENDARS_COPY', () => {
  test('the help says the calendars are kept, and what Townwise keeps of them', () => {
    expect(CALENDARS_COPY.help).toBe(
      'Import a calendar exported from Google Calendar, Outlook or Apple Calendar as an .ics file, or add its iCal link, which Townwise reads again about every 6 hours. Townwise keeps each event’s title, dates and hours until you remove the calendar, and nothing else from it. TownwiseAI reads the titles, so they can reach Anthropic when you ask about your bookings. Events change the forecast only through notes you make from them. To update a file, remove it and import the new export.',
    );
  });

  test('keeps the import’s words and adds the panel’s', () => {
    expect(CALENDARS_COPY.tooLarge).toBe('This file is over 1 MB. Export a shorter range of your calendar.');
    expect(CALENDARS_COPY.notCalendar).toBe('This doesn’t look like a calendar file (.ics).');
    expect(CALENDARS_COPY.unreadable).toBe('Couldn’t read this file. Choose it again.');
    expect(CALENDARS_COPY.none).toBe('No calendars yet.');
    expect(CALENDARS_COPY.nativeLine).toBe('To add events from your own calendar file, open Townwise on the web.');
    expect(CALENDARS_COPY.nameLabel).toBe('Name');
    expect(CALENDARS_COPY.nameHelper).toBe('Up to 60 characters, for example Bookings.');
    expect(CALENDARS_COPY.linkLabel).toBe('Calendar link');
    expect(CALENDARS_COPY.linkHelper)
      .toBe('Its iCal address, starting with https:// or webcal://. In Google Calendar: Settings, then the calendar, then Secret address in iCal format.');
    expect(CALENDARS_COPY.alreadyRemoved).toBe('This calendar was already removed.');
  });
});
