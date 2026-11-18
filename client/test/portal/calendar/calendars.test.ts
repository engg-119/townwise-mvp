import {
  addedLines, addGoogleLabel, addRefusal, CALENDARS_COPY, GOOGLE_COPY, googleRefusal, helpText, labelOfFile, linkProblems, MAX_CALENDARS,
  nativeLine, pickerLine, refreshable, refreshedLine, refreshRefusal, refusedLine, removedLine, roomLine, rowLines, statusWords,
} from '../../../src/portal/calendar/calendars';
import { COPY, errorCopy } from '../../../src/portal/errors';
import { formatDate, formatTime } from '../../../src/portal/format';
import { offline, refusal } from '../../helpers/portal';
import { ownerCalendar } from './fakes';

// The "Your calendars" panel's words (connect-owner-calendar design decision 11, connect-google-calendar design decision
// 15): a file's name, every refusal phase 1 answers, a link's status, a row's lines and the add-a-link form's checks,
// and the Google section's words, every Google refusal and a Google calendar's status. Made-up names only.

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

  test('a Google add’s refusals are googleRefusal’s, calendar_limit and a 429 as for links', () => {
    expect(addRefusal(refusal(400, 'google_not_found'), 'google', 'web')).toBe('That calendar is no longer in your Google account.');
    expect(addRefusal(refusal(409, 'calendar_limit'), 'google', 'web'))
      .toBe('This location has 5 calendars, the most it can hold. Remove one to add another.');
    expect(addRefusal(refusal(429, 'rate_limited', 120), 'google', 'web')).toBe('Too many attempts. Try again in 2 minutes.');
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
    expect(refreshRefusal(refusal(503, 'google_calendar_unavailable')))
      .toBe('Google calendars aren’t available right now. This calendar’s events stay as they are.');
    expect(refreshRefusal(refusal(503, 'google_unavailable'))).toBe('Townwise couldn’t reach Google. Try again in a few minutes.');
    expect(refreshRefusal(refusal(404, 'not_found'))).toBe('This calendar was already removed.');
    expect(refreshRefusal(offline())).toBe(COPY.network);
  });
});

describe('statusWords', () => {
  test('every failure phase 1 records for a link (CALENDAR_STATUSES, api/src/stores/owner-calendars.ts) has its words', () => {
    const words = (status: string): string | null => statusWords(status, 'link');
    expect(words('bad_link')).toBe('Couldn’t refresh: the link now leads to an address that isn’t https.');
    expect(words('blocked_address')).toBe('Couldn’t refresh: the link now leads to an address Townwise doesn’t read.');
    expect(words('unreachable')).toBe('Couldn’t refresh: Townwise couldn’t reach the link.');
    expect(words('timeout')).toBe('Couldn’t refresh: the link took too long to answer.');
    expect(words('too_large')).toBe('Couldn’t refresh: the calendar is over 1 MB.');
    expect(words('http_error')).toBe('Couldn’t refresh: the link answered with an error.');
    expect(words('not_calendar')).toBe('Couldn’t refresh: the link no longer leads to a calendar.');
    expect(words('key_mismatch')).toBe('Townwise can’t open this link any more. Remove it and add the link again.');
  });

  test('every status a Google calendar records has its words, key_mismatch its own for Google', () => {
    const words = (status: string): string | null => statusWords(status, 'google');
    expect(words('google_revoked'))
      .toBe('Couldn’t refresh: Google no longer lets Townwise read this calendar. Whoever added it can connect again with Add a Google calendar, or remove it.');
    expect(words('google_not_found'))
      .toBe('Couldn’t refresh: this Google calendar was deleted or is no longer shared with the account that added it.');
    expect(words('google_forbidden')).toBe('Couldn’t refresh: Google refused to share this calendar’s events.');
    expect(words('google_rate_limited')).toBe('Couldn’t refresh: Google was busy. Townwise tries again later.');
    expect(words('google_unavailable')).toBe('Couldn’t refresh: Townwise couldn’t reach Google.');
    expect(words('key_mismatch')).toBe('Townwise can’t open this Google connection any more. Remove the calendar and add it again.');
    expect(statusWords('key_mismatch', 'link')).toBe('Townwise can’t open this link any more. Remove it and add the link again.');
  });

  test('ok has none, and a code or a kind the client has no words for gets a generic line', () => {
    expect(statusWords('ok', 'link')).toBeNull();
    expect(statusWords('ok', 'google')).toBeNull();
    expect(statusWords('gone_quiet', 'link')).toBe('Couldn’t refresh this link.');
    expect(statusWords('gone_quiet', 'google')).toBe('Couldn’t refresh this calendar.');
    expect(statusWords('timeout', 'outlook')).toBe('Couldn’t refresh this calendar.');
  });
});

describe('googleRefusal', () => {
  test('every code the Google routes and a Google add answer has its words', () => {
    const words = (status: number, code: string): string => googleRefusal(refusal(status, code));
    expect(words(503, 'google_calendar_unavailable')).toBe('Google calendars aren’t available right now. You can still add a link or import a file.');
    expect(words(409, 'google_connect_again')).toBe('Google didn’t give Townwise lasting access. Press Continue to Google again.');
    expect(words(400, 'google_code_invalid')).toBe('Google’s sign-in expired. Try again.');
    expect(words(400, 'google_scope_missing')).toBe('Townwise needs to see your calendars and their events. Try again and leave both boxes checked.');
    expect(words(409, 'google_other_account'))
      .toBe('Choose the Google account you sign in to Townwise with. To add another account’s calendar, share it with that account in Google Calendar first.');
    expect(words(409, 'google_reconnect')).toBe('Connect your Google account again to add calendars.');
    expect(words(409, 'google_not_connected')).toBe('Connect your Google account again to add calendars.');
    expect(words(409, 'calendar_already_added')).toBe('This calendar is already on this location.');
    expect(words(400, 'google_not_found')).toBe('That calendar is no longer in your Google account.');
    expect(words(400, 'google_forbidden')).toBe('Google won’t share that calendar’s events with Townwise.');
    expect(words(503, 'google_unavailable')).toBe('Townwise couldn’t reach Google. Try again in a few minutes.');
    expect(words(409, 'calendar_limit')).toBe('This location has 5 calendars, the most it can hold. Remove one to add another.');
  });

  test('a 429 and anything else get the shared error words, and a code only counts with its own status', () => {
    expect(googleRefusal(refusal(429, 'rate_limited', 120))).toBe('Too many attempts. Try again in 2 minutes.');
    expect(googleRefusal(offline())).toBe(COPY.network);
    expect(googleRefusal(refusal(403, 'view_as_read_only'))).toBe(errorCopy(refusal(403, 'view_as_read_only')));
    expect(googleRefusal(refusal(400, 'google_unavailable'))).toBe(COPY.request);
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

  test('a Google calendar: its kind and count, and Updated from its last refresh that worked', () => {
    const at = '2026-11-14T20:42:00.000Z';
    expect(rowLines(ownerCalendar({ kind: 'google', host: null, eventCount: 40, lastSuccessAt: at })))
      .toEqual({ summary: 'Google calendar, 40 events', repeating: null, updated: `Updated ${formatDate(at)}, ${formatTime(at)}` });
    expect(rowLines(ownerCalendar({ kind: 'google', host: null, eventCount: 1, lastSuccessAt: null })))
      .toEqual({ summary: 'Google calendar, 1 event', repeating: null, updated: null });
  });

  test('a kind the client doesn’t know: “Calendar” and its count, with no Updated line', () => {
    expect(rowLines(ownerCalendar({ kind: 'outlook', host: 'outlook.example.com', eventCount: 3 })))
      .toEqual({ summary: 'Calendar, 3 events', repeating: null, updated: null });
  });

  test('only links and Google calendars are refreshed', () => {
    expect(['file', 'link', 'google', 'outlook'].map(refreshable)).toEqual([false, true, true, false]);
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
  test('the help says the calendars are kept, and what Townwise keeps of them, naming Google calendars only while they are on', () => {
    expect(helpText(true)).toBe(
      'Import a calendar exported from Google Calendar, Outlook or Apple Calendar as an .ics file, or add its iCal link, which Townwise reads again about every 6 hours. Or add a Google calendar by signing in with Google, which Townwise reads about every 6 hours, repeating events included. Townwise keeps each event’s title, dates and hours until you remove the calendar, and nothing else from it. TownwiseAI reads the titles, so they can reach Anthropic when you ask about your bookings. Events change the forecast only through notes you make from them. To update a file, remove it and import the new export.',
    );
    // Off (production until the owner turns them on), the help is as it was before Google calendars.
    expect(helpText(false)).toBe(
      'Import a calendar exported from Google Calendar, Outlook or Apple Calendar as an .ics file, or add its iCal link, which Townwise reads again about every 6 hours. Townwise keeps each event’s title, dates and hours until you remove the calendar, and nothing else from it. TownwiseAI reads the titles, so they can reach Anthropic when you ask about your bookings. Events change the forecast only through notes you make from them. To update a file, remove it and import the new export.',
    );
  });

  test('native’s line points to the web for connecting a Google calendar only while they are on', () => {
    expect(nativeLine(true)).toBe('To import a calendar file or connect a Google calendar, open Townwise on the web.');
    expect(nativeLine(false)).toBe('To add events from your own calendar file, open Townwise on the web.');
  });

  test('keeps the import’s words and adds the panel’s', () => {
    expect(CALENDARS_COPY.tooLarge).toBe('This file is over 1 MB. Export a shorter range of your calendar.');
    expect(CALENDARS_COPY.notCalendar).toBe('This doesn’t look like a calendar file (.ics).');
    expect(CALENDARS_COPY.unreadable).toBe('Couldn’t read this file. Choose it again.');
    expect(CALENDARS_COPY.none).toBe('No calendars yet.');
    expect(CALENDARS_COPY.nameLabel).toBe('Name');
    expect(CALENDARS_COPY.nameHelper).toBe('Up to 60 characters, for example Bookings.');
    expect(CALENDARS_COPY.linkLabel).toBe('Calendar link');
    expect(CALENDARS_COPY.linkHelper)
      .toBe('Its iCal address, starting with https:// or webcal://. In Google Calendar: Settings, then the calendar, then Secret address in iCal format.');
    expect(CALENDARS_COPY.alreadyRemoved).toBe('This calendar was already removed.');
  });
});

describe('the Google section’s words', () => {
  test('the explainer, word for word, and the lines around it', () => {
    expect(GOOGLE_COPY.explainer).toBe(
      'Sign in with Google to pick calendars from your Google account. Townwise reads each event’s title, dates and hours, and nothing else, about every 6 hours, repeating events included. Everyone on your team can see these events. TownwiseAI reads their titles when you ask about your bookings, and each Monday it reads the titles, dates and hours of the next 3 months of events, with email addresses and phone numbers removed, to suggest notes for private events. Either way, the titles reach Anthropic, which doesn’t train on them. An admin of your organization can turn off the Monday reading on the TownwiseAI page. Townwise staff never see these events’ titles on the Calendar. Under view-as, a recorded, read-only view shown to your organization’s admins, they can read your team’s TownwiseAI conversations, which may mention one. Removing your last Google calendar, or leaving your organization, ends Townwise’s access to your Google account. Google may warn that Townwise isn’t verified yet while Google reviews it.',
    );
    // Shown in three paragraphs (what Townwise reads, who sees it, how access ends), with the same words.
    expect(GOOGLE_COPY.explainerShown.split('\n\n')).toHaveLength(3);
    expect(GOOGLE_COPY.explainerShown.replaceAll('\n\n', ' ')).toBe(GOOGLE_COPY.explainer);
    expect(GOOGLE_COPY.add).toBe('Add a Google calendar');
    expect(GOOGLE_COPY.continue).toBe('Continue to Google');
    expect(GOOGLE_COPY.loadingGoogle).toBe('Loading Google…');
    expect(GOOGLE_COPY.loadFailed).toBe('Google’s sign-in didn’t load. Try again.');
    expect(GOOGLE_COPY.waiting).toBe('Waiting for Google…');
    expect(GOOGLE_COPY.stopWaiting).toBe('Stop waiting');
    expect(GOOGLE_COPY.connecting).toBe('Connecting your Google account…');
    expect(GOOGLE_COPY.loadingChoices).toBe('Loading your Google calendars…');
    expect(GOOGLE_COPY.popupBlocked).toBe('Your browser blocked Google’s window. Allow pop-ups for townwise.tech and try again.');
    expect(GOOGLE_COPY.notConnected).toBe('Google didn’t connect Townwise. Try again.');
    expect(GOOGLE_COPY.reconnect).toBe('Connect your Google account again to add calendars.');
  });

  test('the picker’s lines', () => {
    expect(pickerLine('Main Street')).toBe('Choose the calendars to add to Main Street.');
    expect(GOOGLE_COPY.mainCalendar).toBe('Your main calendar');
    expect(GOOGLE_COPY.added).toBe('Added');
    expect(GOOGLE_COPY.shareLine).toBe('To add another Google account’s calendar, share it with this account in Google Calendar first.');
    expect(roomLine(2)).toBe('This location can add 2 more.');
    expect(roomLine(1)).toBe('This location can add 1 more.');
    expect(roomLine(0)).toBe('This location has 5 calendars, the most it can hold. Remove one to add another.');
    expect(MAX_CALENDARS).toBe(5);
    expect(addGoogleLabel(1)).toBe('Add calendar');
    expect(addGoogleLabel(2)).toBe('Add 2 calendars');
    expect(addGoogleLabel(0)).toBe('Add calendars');
    expect(refusedLine('Bookings', 'This calendar is already on this location.')).toBe('Bookings: This calendar is already on this location.');
  });
});
