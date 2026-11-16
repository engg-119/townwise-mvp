// The owner's calendar parser (src/calendar/ics.ts, openspec change connect-owner-calendar): an exported .ics file's
// single events, read on the server with the Calendar page's rules. Repeating events are counted, not imported, only
// events within 400 days of the town's today are kept, at most 2,000, a UTC time is the town's wall time, and an event
// keeps its UID, title (at most 200 characters), dates and hours only. Every title, name and address here is made up.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keepWindow, MAX_EVENTS, MAX_ICS_BYTES, MAX_TITLE_CHARS, parseIcs, WINDOW_DAYS, type IcsEvent } from '../src/calendar/ics.ts';
import { utcDay } from '../src/dates.ts';

const TODAY = '2026-11-11';
const EASTERN = { today: TODAY, timeZone: 'America/New_York' };

/** A calendar file with these lines between BEGIN and END:VCALENDAR, joined with CRLF as exporters write them. */
function calendar(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Calendar//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(...lines: string[]): string[] {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

function eventsOf(text: string, town = EASTERN): IcsEvent[] {
  const result = parseIcs(text, town);
  if ('error' in result) throw new Error(`not a calendar: ${result.error}`);
  return result.events;
}

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

function compact(day: string): string {
  return day.replace(/-/g, '');
}

describe('parseIcs', () => {
  it('reads an all-day event with an exclusive DTEND as one day', () => {
    const text = calendar(
      ...vevent('UID:a1@example.com', 'SUMMARY:Staff party', 'DTSTART;VALUE=DATE:20261121', 'DTEND;VALUE=DATE:20261122'),
      ...vevent('UID:a2@example.com', 'SUMMARY:Inventory weekend', 'DTSTART;VALUE=DATE:20261205', 'DTEND;VALUE=DATE:20261207'),
      // No DTEND: one day.
      ...vevent('UID:a3@example.com', 'SUMMARY:Deep clean', 'DTSTART;VALUE=DATE:20261130'),
      // A canceled event is not on the calendar.
      ...vevent('UID:a4@example.com', 'SUMMARY:Called off', 'STATUS:CANCELLED', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261202'),
    );
    expect(parseIcs(text, EASTERN)).toEqual({
      events: [
        { uid: 'a1@example.com', title: 'Staff party', startDate: '2026-11-21', endDate: '2026-11-21', startTime: null, endTime: null },
        { uid: 'a3@example.com', title: 'Deep clean', startDate: '2026-11-30', endDate: '2026-11-30', startTime: null, endTime: null },
        { uid: 'a2@example.com', title: 'Inventory weekend', startDate: '2026-12-05', endDate: '2026-12-06', startTime: null, endTime: null },
      ],
      skippedRepeating: 0,
    });
  });

  it('reads timed events with local, TZID and UTC times, folded lines and escaped text', () => {
    const text = calendar(
      // A floating (local) time, its title folded over two lines and escaped.
      ...vevent('UID:t1', 'SUMMARY:Rehearsal dinner\\, upstairs \\; back ro', ' om\\nby the bar \\\\ patio', 'DTSTART:20261121T180000', 'DTEND:20261121T213000'),
      // A TZID time is the wall time it names, even with a quoted parameter holding a colon.
      ...vevent('UID:t2', 'SUMMARY:Wine tasting', 'DTSTART;TZID="America/New_York":20261124T170000', 'DTEND;TZID="America/New_York":20261124T190000'),
      // A UTC time is the town's wall time: 23:30Z to 01:00Z is 18:30 to 20:00 Eastern.
      ...vevent('UID:t3', 'SUMMARY:Supplier call', 'DTSTART:20261203T233000Z', 'DTEND:20261204T010000Z'),
      // Over midnight, ending by 06:00 the next morning: the start day's late night, its hours kept (the end before the start).
      ...vevent('UID:t4', 'SUMMARY:Late shift', 'DTSTART:20261212T220000', 'DTEND:20261213T020000'),
      // Ending at 06:00 exactly is still the start day's; at 07:00 it is two days, with no hours.
      ...vevent('UID:t7', 'SUMMARY:All-night bake', 'DTSTART:20261229T190000', 'DTEND:20261230T060000'),
      ...vevent('UID:t8', 'SUMMARY:Overnight inventory', 'DTSTART:20261230T200000', 'DTEND:20261231T070000'),
      // A day or more long: two dates, though it ends early in the morning.
      ...vevent('UID:t9', 'SUMMARY:Two-day fair', 'DTSTART:20261231T050000', 'DTEND:20270101T050000'),
      // Ends at midnight: its own day, no hours (an hour range ends by midnight on its own day).
      ...vevent('UID:t5', 'SUMMARY:Holiday party', 'DTSTART:20261218T190000', 'DTEND:20261219T000000'),
      // An alarm's own lines are not the event's.
      ...vevent('UID:t6', 'SUMMARY:Delivery', 'DTSTART:20261228T090000', 'DTEND:20261228T100000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'SUMMARY:Alarm text', 'END:VALARM'),
    );
    expect(eventsOf(text)).toEqual([
      { uid: 't1', title: 'Rehearsal dinner, upstairs ; back room by the bar \\ patio', startDate: '2026-11-21', endDate: '2026-11-21', startTime: '18:00', endTime: '21:30' },
      { uid: 't2', title: 'Wine tasting', startDate: '2026-11-24', endDate: '2026-11-24', startTime: '17:00', endTime: '19:00' },
      { uid: 't3', title: 'Supplier call', startDate: '2026-12-03', endDate: '2026-12-03', startTime: '18:30', endTime: '20:00' },
      { uid: 't4', title: 'Late shift', startDate: '2026-12-12', endDate: '2026-12-12', startTime: '22:00', endTime: '02:00' },
      { uid: 't5', title: 'Holiday party', startDate: '2026-12-18', endDate: '2026-12-18', startTime: null, endTime: null },
      { uid: 't6', title: 'Delivery', startDate: '2026-12-28', endDate: '2026-12-28', startTime: '09:00', endTime: '10:00' },
      { uid: 't7', title: 'All-night bake', startDate: '2026-12-29', endDate: '2026-12-29', startTime: '19:00', endTime: '06:00' },
      { uid: 't8', title: 'Overnight inventory', startDate: '2026-12-30', endDate: '2026-12-31', startTime: null, endTime: null },
      { uid: 't9', title: 'Two-day fair', startDate: '2026-12-31', endDate: '2027-01-01', startTime: null, endTime: null },
    ]);
    // LF-only files and a missing title read too.
    const bare = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20261121T180000', 'DTEND:20261121T200000', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
    expect(eventsOf(bare)).toEqual([{ uid: 'event-1', title: 'Untitled event', startDate: '2026-11-21', endDate: '2026-11-21', startTime: '18:00', endTime: '20:00' }]);
  });

  it('counts repeating events instead of importing them', () => {
    const text = calendar(
      ...vevent('UID:r1', 'SUMMARY:Weekly staff meeting', 'DTSTART:20261102T090000', 'DTEND:20261102T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO'),
      ...vevent('UID:r2', 'SUMMARY:Trivia night', 'DTSTART:20261104T190000', 'DTEND:20261104T210000', 'RDATE:20261118T190000'),
      // A moved instance of a repeating event belongs to its series, which is already counted.
      ...vevent('UID:r1', 'SUMMARY:Weekly staff meeting', 'RECURRENCE-ID:20261109T090000', 'DTSTART:20261110T090000', 'DTEND:20261110T100000'),
      ...vevent('UID:s1', 'SUMMARY:Owner away', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261126'),
    );
    expect(parseIcs(text, EASTERN)).toEqual({
      events: [{ uid: 's1', title: 'Owner away', startDate: '2026-11-25', endDate: '2026-11-25', startTime: null, endTime: null }],
      skippedRepeating: 2,
    });
  });

  it('keeps 3 single events and counts 2 with an RRULE (the owner-calendar spec scenario)', () => {
    const single = (uid: string, day: string): string[] => vevent(`UID:${uid}`, `SUMMARY:${uid}`, `DTSTART;VALUE=DATE:${day}`);
    const repeating = (uid: string, day: string): string[] => vevent(`UID:${uid}`, `SUMMARY:${uid}`, `DTSTART;VALUE=DATE:${day}`, 'RRULE:FREQ=MONTHLY');
    const result = parseIcs(calendar(...single('one', '20261120'), ...repeating('two', '20261121'), ...single('three', '20261122'),
      ...repeating('four', '20261123'), ...single('five', '20261124')), EASTERN);
    expect(result).toMatchObject({ skippedRepeating: 2 });
    expect('events' in result ? result.events.map((event) => event.uid) : null).toEqual(['one', 'three', 'five']);
  });

  it('answers not_calendar for a file with no VCALENDAR', () => {
    expect(parseIcs('', EASTERN)).toEqual({ error: 'not_calendar' });
    expect(parseIcs('date,guests,net_sales\n2026-11-01,120,2400.00\n', EASTERN)).toEqual({ error: 'not_calendar' });
    expect(parseIcs('<!doctype html><html><body>Sign in</body></html>', EASTERN)).toEqual({ error: 'not_calendar' });
    expect(parseIcs(['BEGIN:VEVENT', 'DTSTART:20261121T180000', 'END:VEVENT'].join('\r\n'), EASTERN)).toEqual({ error: 'not_calendar' });
    // A calendar with no events is still a calendar.
    expect(parseIcs(calendar(), EASTERN)).toEqual({ events: [], skippedRepeating: 0 });
    // A byte order mark and lower-case names are fine.
    expect(parseIcs(`\uFEFF${calendar().toLowerCase()}`, EASTERN)).toEqual({ events: [], skippedRepeating: 0 });
  });

  it('keeps events within 400 days of today, at most 2,000', () => {
    const allDay = (uid: string, from: string, to: string): string[] =>
      vevent(`UID:${uid}`, `SUMMARY:${uid}`, `DTSTART;VALUE=DATE:${compact(from)}`, `DTEND;VALUE=DATE:${compact(plusDays(to, 1))}`);
    expect(WINDOW_DAYS).toBe(400);
    const first = plusDays(TODAY, -400);
    const last = plusDays(TODAY, 400);
    const text = calendar(
      ...allDay('too-early', plusDays(first, -3), plusDays(first, -1)),
      ...allDay('ends-on-first', plusDays(first, -3), first),
      ...allDay('starts-on-last', last, plusDays(last, 2)),
      ...allDay('too-late', plusDays(last, 1), plusDays(last, 1)),
    );
    expect(eventsOf(text).map((event) => event.uid)).toEqual(['ends-on-first', 'starts-on-last']);

    // Over 2,000: the first 2,000 by start, whatever order the file lists them in.
    const many: string[] = [];
    const listed: string[] = [];
    for (let index = 2_049; index >= 0; index -= 1) {
      const day = plusDays('2026-01-01', index % 300);
      const hour = String(10 + (index % 10));
      many.push(...vevent(`UID:m${String(index)}`, 'SUMMARY:Shift', `DTSTART:${compact(day)}T${hour}0000`, `DTEND:${compact(day)}T230000`));
      listed.push(`${day} ${hour}:00`);
    }
    const kept = eventsOf(calendar(...many));
    expect(MAX_EVENTS).toBe(2_000);
    expect(kept.map((event) => `${event.startDate} ${event.startTime ?? ''}`)).toEqual(listed.sort().slice(0, MAX_EVENTS));
  });

  it('gives a repeated UID a suffix, so each imported event keeps its own key', () => {
    const text = calendar(
      ...vevent('UID:d1', 'SUMMARY:Wine tasting', 'DTSTART;VALUE=DATE:20261121'),
      ...vevent('UID:d1', 'SUMMARY:Wine tasting again', 'DTSTART;VALUE=DATE:20261128'),
      ...vevent('UID:d1', 'SUMMARY:Last wine tasting', 'DTSTART;VALUE=DATE:20261205'),
    );
    expect(eventsOf(text).map((event) => [event.uid, event.title])).toEqual([
      ['d1', 'Wine tasting'], ['d1#2', 'Wine tasting again'], ['d1#3', 'Last wine tasting'],
    ]);

    // A suffixed or made-up key that the file also states is taken too, whichever comes first.
    const clash = calendar(
      ...vevent('UID:a#3', 'SUMMARY:Stated', 'DTSTART;VALUE=DATE:20261121'),
      ...vevent('UID:a', 'SUMMARY:First', 'DTSTART;VALUE=DATE:20261122'),
      ...vevent('UID:a', 'SUMMARY:Second', 'DTSTART;VALUE=DATE:20261123'),
      ...vevent('UID:event-5', 'SUMMARY:Stated made-up', 'DTSTART;VALUE=DATE:20261124'),
      ...vevent('SUMMARY:No UID', 'DTSTART;VALUE=DATE:20261125'),
      ...vevent('SUMMARY:No UID again', 'DTSTART;VALUE=DATE:20261126'),
      ...vevent('UID:event-6', 'SUMMARY:Stated after', 'DTSTART;VALUE=DATE:20261127'),
    );
    const kept = eventsOf(clash).map((event) => [event.uid, event.title]);
    expect(kept).toEqual([
      ['a#3', 'Stated'], ['a', 'First'], ['a#4', 'Second'], ['event-5', 'Stated made-up'],
      ['event-5#5', 'No UID'], ['event-6', 'No UID again'], ['event-6#7', 'Stated after'],
    ]);
    expect(new Set(kept.map(([uid]) => uid)).size).toBe(kept.length);
  });

  it('finds a free suffix in one pass, even when the file states every suffix first', () => {
    // Under 1 MB: x#9001 to x#18000 stated, then 9,000 events with UID x. Searching from each event's own number walked
    // every stated suffix again for each clash, about 81 million looks, and held the event loop for seconds.
    const clashes = 9_000;
    const lines: string[] = [];
    for (let index = 1; index <= clashes; index += 1) lines.push(...vevent(`UID:x#${String(clashes + index)}`, 'DTSTART:20261122'));
    for (let index = 1; index <= clashes; index += 1) lines.push(...vevent('UID:x', 'DTSTART:20261121'));
    const text = calendar(...lines);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_ICS_BYTES);
    const started = performance.now();
    const kept = eventsOf(text).map((event) => event.uid);
    expect(performance.now() - started).toBeLessThan(1_000);
    // The clashing events come first by start, each with the first suffix free from its own number on.
    expect(kept.slice(0, 3)).toEqual(['x', 'x#18001', 'x#18002']);
    expect(kept.at(-1)).toBe('x#19999');
    expect(new Set(kept).size).toBe(MAX_EVENTS);
  });
});

describe('parseIcs in the town’s time zone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a UTC time as the wall time in the town’s zone, and a TZID or floating time as it is written', () => {
    const text = calendar(
      // 03:00Z to 06:00Z on Dec 4.
      ...vevent('UID:z1', 'SUMMARY:Catering pickup', 'DTSTART:20261204T030000Z', 'DTEND:20261204T060000Z'),
      ...vevent('UID:z2', 'SUMMARY:Tasting menu', 'DTSTART;TZID=America/Los_Angeles:20261124T170000', 'DTEND;TZID=America/Los_Angeles:20261124T190000'),
      ...vevent('UID:z3', 'SUMMARY:Buyout', 'DTSTART:20261126T120000', 'DTEND:20261126T150000'),
    );
    const zoned = (timeZone: string): IcsEvent[] => eventsOf(text, { today: TODAY, timeZone });
    const asWritten: IcsEvent[] = [
      { uid: 'z2', title: 'Tasting menu', startDate: '2026-11-24', endDate: '2026-11-24', startTime: '17:00', endTime: '19:00' },
      { uid: 'z3', title: 'Buyout', startDate: '2026-11-26', endDate: '2026-11-26', startTime: '12:00', endTime: '15:00' },
    ];
    // Eastern: 22:00 on Dec 3 to 01:00, the start day's late night.
    expect(zoned('America/New_York')).toEqual([
      ...asWritten,
      { uid: 'z1', title: 'Catering pickup', startDate: '2026-12-03', endDate: '2026-12-03', startTime: '22:00', endTime: '01:00' },
    ]);
    expect(zoned('America/Los_Angeles').at(-1)).toEqual(
      { uid: 'z1', title: 'Catering pickup', startDate: '2026-12-03', endDate: '2026-12-03', startTime: '19:00', endTime: '22:00' },
    );
    expect(zoned('Pacific/Honolulu').at(-1)).toMatchObject({ startDate: '2026-12-03', startTime: '17:00', endTime: '20:00' });
    expect(zoned('UTC').at(-1)).toMatchObject({ startDate: '2026-12-04', endDate: '2026-12-04', startTime: '03:00', endTime: '06:00' });
    for (const timeZone of ['America/Los_Angeles', 'Pacific/Honolulu', 'UTC']) expect(zoned(timeZone).slice(0, 2)).toEqual(asWritten);
  });

  it('follows the town’s daylight saving change', () => {
    // 06:30Z is 01:30 EST and 07:30Z is 03:30 EDT on 2026-03-08, when Eastern clocks skip from 02:00 to 03:00.
    const text = calendar(...vevent('UID:dst', 'SUMMARY:Brunch prep', 'DTSTART:20260308T063000Z', 'DTEND:20260308T073000Z'));
    expect(eventsOf(text)).toEqual([{ uid: 'dst', title: 'Brunch prep', startDate: '2026-03-08', endDate: '2026-03-08', startTime: '01:30', endTime: '03:30' }]);
  });

  it('skips an event whose start cannot be read, never failing the file', () => {
    const text = calendar(
      ...vevent('UID:bad-date', 'SUMMARY:No such day', 'DTSTART;VALUE=DATE:20261131'),
      ...vevent('UID:bad-hour', 'SUMMARY:No such hour', 'DTSTART:20261121T250000'),
      // 1000-01-01 03:00Z is still 999 in Eastern time, a date the API cannot write.
      ...vevent('UID:too-old', 'SUMMARY:Too old', 'DTSTART:10000101T030000Z', 'DTEND:10000102T030000Z'),
      ...vevent('UID:fine', 'SUMMARY:Fine', 'DTSTART;VALUE=DATE:20261121'),
    );
    expect(eventsOf(text).map((event) => event.uid)).toEqual(['fine']);
  });

  it('keeps the window around the town’s today, never the server’s clock', () => {
    // The server's clock reads 2040: the window still follows the today the caller passes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2040-06-01T12:00:00Z'));
    const first = plusDays(TODAY, -400);
    const text = calendar(
      ...vevent('UID:edge', 'SUMMARY:Old event', `DTSTART;VALUE=DATE:${compact(first)}`),
      ...vevent('UID:soon', 'SUMMARY:Next week', 'DTSTART;VALUE=DATE:20261118'),
    );
    expect(eventsOf(text).map((event) => event.uid)).toEqual(['edge', 'soon']);
    // A day later in the town, the first day has left the window.
    expect(eventsOf(text, { today: plusDays(TODAY, 1), timeZone: 'America/New_York' }).map((event) => event.uid)).toEqual(['soon']);
  });
});

describe('what an event keeps', () => {
  it('keeps the UID, title, dates and hours only: DESCRIPTION, LOCATION, ATTENDEE and ORGANIZER are never read', () => {
    const text = calendar(...vevent(
      'UID:p1@example.com',
      'DESCRIPTION:Deposit paid by card ending 0000\\, allergy list attached',
      'LOCATION:12 Example Street\\, Back room',
      'ATTENDEE;CN="Example, Pat";ROLE=REQ-PARTICIPANT:mailto:pat@example.com',
      'ORGANIZER;CN=Sam Example:mailto:sam@example.com',
      'SUMMARY:Private party',
      'URL:https://bookings.example.com/p1',
      'X-ALT-DESC;FMTTYPE=text/html:<p>Secret</p>',
      'DTSTART;TZID=America/New_York:20261121T180000',
      'DTEND;TZID=America/New_York:20261121T220000',
    ));
    const result = parseIcs(text, EASTERN);
    expect(result).toEqual({
      events: [{ uid: 'p1@example.com', title: 'Private party', startDate: '2026-11-21', endDate: '2026-11-21', startTime: '18:00', endTime: '22:00' }],
      skippedRepeating: 0,
    });
    const event = 'events' in result ? result.events[0] : undefined;
    expect(Object.keys(event ?? {}).sort()).toEqual(['endDate', 'endTime', 'startDate', 'startTime', 'title', 'uid']);
    const serialized = JSON.stringify(result);
    for (const dropped of ['Deposit', 'allergy', 'Example Street', 'Back room', 'pat@example.com', 'Pat', 'sam@example.com', 'Sam', 'bookings.example.com', 'Secret']) {
      expect(serialized).not.toContain(dropped);
    }
  });

  it('cuts a title at 200 characters, after unescaping, never through a surrogate pair', () => {
    const titleOf = (summary: string): string | undefined => eventsOf(calendar(...vevent('UID:c', `SUMMARY:${summary}`, 'DTSTART;VALUE=DATE:20261121')))[0]?.title;
    expect(MAX_TITLE_CHARS).toBe(200);
    expect(titleOf('A'.repeat(250))).toBe('A'.repeat(200));
    expect(titleOf('B'.repeat(200))).toBe('B'.repeat(200));
    // 300 characters as written, 200 once "\," reads as ",".
    expect(titleOf('x\\,'.repeat(100))).toBe('x,'.repeat(100));
    // Spaces and line breaks collapse before the cut.
    expect(titleOf(`D${' '.repeat(300)}E`)).toBe('D E');
    // An emoji across the 200th character is left out whole, not split.
    expect(titleOf(`${'C'.repeat(199)}\u{1F600}tail`)).toBe('C'.repeat(199));
    expect(titleOf(`${'C'.repeat(198)}\u{1F600}tail`)).toBe(`${'C'.repeat(198)}\u{1F600}`);
  });
});

describe('keepWindow (shared with Google calendars, openspec change connect-google-calendar)', () => {
  const allDay = (uid: string, startDate: string, endDate = startDate): IcsEvent => ({
    uid, title: uid, startDate, endDate, startTime: null, endTime: null,
  });
  /** `count` one-day events from `firstDay` on, `perDay` a day, listed newest first. */
  const days = (prefix: string, firstDay: string, count: number, perDay = 1): IcsEvent[] =>
    Array.from({ length: count }, (_, index) => allDay(`${prefix}${String(index)}`, plusDays(firstDay, Math.floor(index / perDay)))).reverse();
  const outside = [allDay('too-early', plusDays(TODAY, -WINDOW_DAYS - 2), plusDays(TODAY, -WINDOW_DAYS - 1)), allDay('too-late', plusDays(TODAY, WINDOW_DAYS + 1))];
  const starts = (events: readonly IcsEvent[]): string[] => events.map((event) => event.startDate);

  it('without options keeps the window and the first 2,000 by start, as parseIcs does', () => {
    const earlier = days('before-', plusDays(TODAY, -300), 300);
    const ahead = days('ahead-', TODAY, 1_800, 5);
    const kept = keepWindow([...outside, ...ahead, ...earlier], TODAY);
    expect(kept).toHaveLength(MAX_EVENTS);
    // Every earlier event, then the first 1,700 ahead: the latest ahead ones are cut.
    expect(kept.slice(0, 300).map((event) => event.uid)).toEqual(earlier.map((event) => event.uid).reverse());
    expect(kept.at(-1)?.startDate).toBe(plusDays(TODAY, 339));
    expect(starts(kept)).toEqual(starts(kept).slice().sort());
    expect(kept.map((event) => event.uid)).not.toContain('too-early');
    // Events starting together keep the order they came in.
    const twins = [allDay('second', TODAY), allDay('first', plusDays(TODAY, -1)), allDay('third', TODAY)];
    expect(keepWindow(twins, TODAY).map((event) => event.uid)).toEqual(['first', 'second', 'third']);
  });

  it('with aheadFirst keeps the events ending on or after today first, then the latest earlier ones that fit, by start', () => {
    const earlier = days('before-', plusDays(TODAY, -30), 30);
    // Started before today and still on: it ends today, so it is ahead.
    const spanning = allDay('spanning', plusDays(TODAY, -45), TODAY);
    const ahead = days('ahead-', TODAY, 1_989, 5);
    const kept = keepWindow([...outside, ...earlier, spanning, ...ahead], TODAY, { aheadFirst: true });
    expect(kept).toHaveLength(MAX_EVENTS);
    const uids = kept.map((event) => event.uid);
    expect(uids).toContain('spanning');
    for (const event of ahead) expect(uids).toContain(event.uid);
    // 10 left for the earlier ones: the 10 latest, the days just before today.
    const keptEarlier = kept.filter((event) => event.uid.startsWith('before-'));
    expect(starts(keptEarlier)).toEqual(Array.from({ length: 10 }, (_, index) => plusDays(TODAY, index - 10)));
    expect(starts(kept)).toEqual(starts(kept).slice().sort());
    expect(uids).not.toContain('too-early');
    expect(uids).not.toContain('too-late');

    // More than 2,000 ahead: the first 2,000 of them by start, and no earlier one.
    const busy = keepWindow([...earlier, ...days('busy-', TODAY, 2_050, 20)], TODAY, { aheadFirst: true });
    expect(busy).toHaveLength(MAX_EVENTS);
    expect(busy.every((event) => event.uid.startsWith('busy-'))).toBe(true);
    expect(busy.at(-1)?.startDate).toBe(plusDays(TODAY, 99));

    // Under 2,000 in all: everything in the window is kept.
    expect(keepWindow([...outside, ...earlier, spanning], TODAY, { aheadFirst: true })).toHaveLength(31);
    // The same events without aheadFirst keep the earliest instead.
    expect(keepWindow([...earlier, ...days('busy-', TODAY, 2_050, 20)], TODAY).slice(0, 30).map((event) => event.uid))
      .toEqual(earlier.map((event) => event.uid).reverse());
  });
});
