import { MAX_IMPORTED, parseIcs } from '../../../src/portal/calendar/ics';
import type { ImportedEvent } from '../../../src/portal/calendar/model';
import { addDays } from '../../../src/portal/locations/dates';

// The owner's calendar file (spec 16.3 P27 and 17): parseIcs reads an exported .ics file's single events in
// the browser. Repeating events are counted, not imported, and only events within 400 days of today are kept, at most
// 2,000. Every title here is made up.

const TODAY = '2026-11-11';

/** A calendar file with these lines between BEGIN and END:VCALENDAR, joined with CRLF as exporters write them. */
function calendar(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example//Calendar//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n');
}

function vevent(...lines: string[]): string[] {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

function eventsOf(text: string): ImportedEvent[] {
  const result = parseIcs(text, TODAY);
  if ('error' in result) throw new Error(`not a calendar: ${result.error}`);
  return result.events;
}

/** The device's local date and HH:MM for a UTC instant, as the parser reads a `Z` time. */
function local(utc: number): { date: string; time: string } {
  const at = new Date(utc);
  const two = (value: number): string => String(value).padStart(2, '0');
  return { date: `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`, time: `${two(at.getHours())}:${two(at.getMinutes())}` };
}

test('reads an all-day event with an exclusive DTEND as one day', () => {
  const text = calendar(
    ...vevent('UID:a1@example.com', 'SUMMARY:Staff party', 'DTSTART;VALUE=DATE:20261121', 'DTEND;VALUE=DATE:20261122'),
    ...vevent('UID:a2@example.com', 'SUMMARY:Inventory weekend', 'DTSTART;VALUE=DATE:20261205', 'DTEND;VALUE=DATE:20261207'),
    // No DTEND: one day.
    ...vevent('UID:a3@example.com', 'SUMMARY:Deep clean', 'DTSTART;VALUE=DATE:20261130'),
    // A cancelled event is not on the calendar.
    ...vevent('UID:a4@example.com', 'SUMMARY:Called off', 'STATUS:CANCELLED', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261202'),
  );
  expect(parseIcs(text, TODAY)).toEqual({
    events: [
      { uid: 'a1@example.com', title: 'Staff party', startDate: '2026-11-21', endDate: '2026-11-21', startTime: null, endTime: null },
      { uid: 'a3@example.com', title: 'Deep clean', startDate: '2026-11-30', endDate: '2026-11-30', startTime: null, endTime: null },
      { uid: 'a2@example.com', title: 'Inventory weekend', startDate: '2026-12-05', endDate: '2026-12-06', startTime: null, endTime: null },
    ],
    skippedRepeating: 0,
  });
});

test('reads timed events with local, TZID and UTC times, folded lines and escaped text', () => {
  const utc = Date.UTC(2026, 11, 3, 23, 30);
  const utcEnd = utc + 90 * 60 * 1000;
  const text = calendar(
    // A floating (local) time, its title folded over two lines and escaped.
    ...vevent('UID:t1', 'SUMMARY:Rehearsal dinner\\, upstairs \\; back ro', ' om\\nby the bar \\\\ patio', 'DTSTART:20261121T180000', 'DTEND:20261121T213000'),
    // A TZID time is the wall time it names, even with a quoted parameter holding a colon.
    ...vevent('UID:t2', 'SUMMARY:Wine tasting', 'DTSTART;TZID="America/New_York":20261124T170000', 'DTEND;TZID="America/New_York":20261124T190000'),
    // A UTC time is the device's local time.
    ...vevent('UID:t3', 'SUMMARY:Supplier call', 'DTSTART:20261203T233000Z', 'DTEND:20261204T010000Z'),
    // Over midnight: two dates, so no hours.
    ...vevent('UID:t4', 'SUMMARY:Late shift', 'DTSTART:20261212T220000', 'DTEND:20261213T020000'),
    // Ends at midnight: its own day, no hours (an hour range ends by midnight on its own day).
    ...vevent('UID:t5', 'SUMMARY:Holiday party', 'DTSTART:20261218T190000', 'DTEND:20261219T000000'),
    // An alarm's own lines are not the event's.
    ...vevent('UID:t6', 'SUMMARY:Delivery', 'DTSTART:20261228T090000', 'DTEND:20261228T100000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'SUMMARY:Alarm text', 'END:VALARM'),
  );
  const start = local(utc);
  const end = local(utcEnd);
  const sameDay = start.date === end.date;
  expect(eventsOf(text)).toEqual([
    { uid: 't1', title: 'Rehearsal dinner, upstairs ; back room by the bar \\ patio', startDate: '2026-11-21', endDate: '2026-11-21', startTime: '18:00', endTime: '21:30' },
    { uid: 't2', title: 'Wine tasting', startDate: '2026-11-24', endDate: '2026-11-24', startTime: '17:00', endTime: '19:00' },
    {
      uid: 't3', title: 'Supplier call', startDate: start.date, endDate: end.date,
      startTime: sameDay ? start.time : null, endTime: sameDay ? end.time : null,
    },
    { uid: 't4', title: 'Late shift', startDate: '2026-12-12', endDate: '2026-12-13', startTime: null, endTime: null },
    { uid: 't5', title: 'Holiday party', startDate: '2026-12-18', endDate: '2026-12-18', startTime: null, endTime: null },
    { uid: 't6', title: 'Delivery', startDate: '2026-12-28', endDate: '2026-12-28', startTime: '09:00', endTime: '10:00' },
  ]);
  // LF-only files and a missing title read too.
  const bare = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20261121T180000', 'DTEND:20261121T200000', 'END:VEVENT', 'END:VCALENDAR'].join('\n');
  expect(eventsOf(bare)).toEqual([{ uid: 'event-1', title: 'Untitled event', startDate: '2026-11-21', endDate: '2026-11-21', startTime: '18:00', endTime: '20:00' }]);
});

test('counts repeating events instead of importing them', () => {
  const text = calendar(
    ...vevent('UID:r1', 'SUMMARY:Weekly staff meeting', 'DTSTART:20261102T090000', 'DTEND:20261102T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO'),
    ...vevent('UID:r2', 'SUMMARY:Trivia night', 'DTSTART:20261104T190000', 'DTEND:20261104T210000', 'RDATE:20261118T190000'),
    // A moved instance of a repeating event belongs to its series, which is already counted.
    ...vevent('UID:r1', 'SUMMARY:Weekly staff meeting', 'RECURRENCE-ID:20261109T090000', 'DTSTART:20261110T090000', 'DTEND:20261110T100000'),
    ...vevent('UID:s1', 'SUMMARY:Owner away', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261126'),
  );
  expect(parseIcs(text, TODAY)).toEqual({
    events: [{ uid: 's1', title: 'Owner away', startDate: '2026-11-25', endDate: '2026-11-25', startTime: null, endTime: null }],
    skippedRepeating: 2,
  });
});

test('answers not_calendar for a file with no VCALENDAR', () => {
  expect(parseIcs('', TODAY)).toEqual({ error: 'not_calendar' });
  expect(parseIcs('date,guests,net_sales\n2026-11-01,120,2400.00\n', TODAY)).toEqual({ error: 'not_calendar' });
  expect(parseIcs(['BEGIN:VEVENT', 'DTSTART:20261121T180000', 'END:VEVENT'].join('\r\n'), TODAY)).toEqual({ error: 'not_calendar' });
  // A calendar with no events is still a calendar.
  expect(parseIcs(calendar(), TODAY)).toEqual({ events: [], skippedRepeating: 0 });
  // A byte order mark and lower-case names are fine.
  expect(parseIcs(`\uFEFF${calendar().toLowerCase()}`, TODAY)).toEqual({ events: [], skippedRepeating: 0 });
});

test('keeps events within 400 days of today, at most 2,000', () => {
  const compact = (day: string): string => day.replace(/-/g, '');
  const allDay = (uid: string, from: string, to: string): string[] =>
    vevent(`UID:${uid}`, `SUMMARY:${uid}`, `DTSTART;VALUE=DATE:${compact(from)}`, `DTEND;VALUE=DATE:${compact(addDays(to, 1))}`);
  const first = addDays(TODAY, -400);
  const last = addDays(TODAY, 400);
  const text = calendar(
    ...allDay('too-early', addDays(first, -3), addDays(first, -1)),
    ...allDay('ends-on-first', addDays(first, -3), first),
    ...allDay('starts-on-last', last, addDays(last, 2)),
    ...allDay('too-late', addDays(last, 1), addDays(last, 1)),
  );
  expect(eventsOf(text).map((event) => event.uid)).toEqual(['ends-on-first', 'starts-on-last']);

  // Over 2,000: the first 2,000 by start, whatever order the file lists them in.
  const many: string[] = [];
  const listed: string[] = [];
  for (let index = 2_049; index >= 0; index -= 1) {
    const day = addDays('2026-01-01', index % 300);
    const hour = String(10 + (index % 10));
    many.push(...vevent(`UID:m${String(index)}`, 'SUMMARY:Shift', `DTSTART:${compact(day)}T${hour}0000`, `DTEND:${compact(day)}T230000`));
    listed.push(`${day} ${hour}:00`);
  }
  const kept = eventsOf(calendar(...many));
  expect(MAX_IMPORTED).toBe(2_000);
  expect(kept.map((event) => `${event.startDate} ${event.startTime ?? ''}`)).toEqual(listed.sort().slice(0, MAX_IMPORTED));
});

test('gives a repeated UID a suffix, so each imported event keeps its own key', () => {
  const text = calendar(
    ...vevent('UID:d1', 'SUMMARY:Wine tasting', 'DTSTART;VALUE=DATE:20261121'),
    ...vevent('UID:d1', 'SUMMARY:Wine tasting again', 'DTSTART;VALUE=DATE:20261128'),
    ...vevent('UID:d1', 'SUMMARY:Last wine tasting', 'DTSTART;VALUE=DATE:20261205'),
  );
  expect(eventsOf(text).map((event) => [event.uid, event.title])).toEqual([
    ['d1', 'Wine tasting'], ['d1#2', 'Wine tasting again'], ['d1#3', 'Last wine tasting'],
  ]);
});
