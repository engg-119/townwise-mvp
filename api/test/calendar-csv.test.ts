// A calendar exported as CSV (src/calendar/csv-events.ts, openspec change learn-from-calendar-bookings, D58): detected by
// its header, read in code with the town's clock and the .ics day rules, keeping a uid, title, dates and hours only, and
// a file calendar's 3-year window. Every row, title, name, email and address here is made up.
import { describe, expect, it } from 'vitest';

import { parseCalendarCsv, parseCalendarFile } from '../src/calendar/csv-events.ts';
import { FILE_HISTORY_DAYS, keepWindow, MAX_EVENTS, WINDOW_DAYS, type IcsEvent } from '../src/calendar/ics.ts';
import { utcDay } from '../src/dates.ts';

const TODAY = '2026-11-18';
const EASTERN = { today: TODAY, timeZone: 'America/New_York' };
const CENTRAL = { today: TODAY, timeZone: 'America/Chicago' };

const HEADER = ['calendar_id', 'event_id', 'recurring_event_id', 'title', 'description', 'location', 'start_at', 'end_at', 'timezone', 'status',
  'organizer_email', 'google_calendar_url'];

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

/** One CSV field, quoted when it needs to be (RFC 4180). */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

interface Row {
  id?: string; title?: string; start: string; end: string; status?: string; description?: string; location?: string;
  organizer?: string; url?: string; series?: string;
}

/** A CSV in the export's column order, CRLF between records. */
function csv(rows: readonly Row[], header: readonly string[] = HEADER): string {
  const cells = (row: Row): Record<string, string> => ({
    calendar_id: 'made-up-calendar@group.example.com', event_id: row.id ?? '', recurring_event_id: row.series ?? '', title: row.title ?? '',
    description: row.description ?? '', location: row.location ?? '', start_at: row.start, end_at: row.end, timezone: 'America/New_York',
    status: row.status ?? 'confirmed', organizer_email: row.organizer ?? '', google_calendar_url: row.url ?? '',
  });
  return [header.join(','), ...rows.map((row) => {
    const values = cells(row);
    return header.map((name) => field(values[name.trim().toLowerCase()] ?? '')).join(',');
  })].join('\r\n');
}

function eventsOf(text: string, town = EASTERN): IcsEvent[] {
  const result = parseCalendarCsv(text, town);
  if ('error' in result) throw new Error('not a calendar CSV');
  return result.events;
}

describe('parseCalendarCsv', () => {
  it('reads the header in any order and case, other columns ignored, and a quoted description with line breaks and commas', () => {
    const header = ['  END_AT ', 'Title', 'notes', 'Start_At', 'EVENT_ID'];
    const text = [
      header.join(','),
      ['2026-12-05T22:00:00-05:00', 'Holiday party', '"Bring, the cake\r\nand the ""good"" plates\nthanks"', '2026-12-05T19:00:00-05:00', 'evt-1'].join(','),
    ].join('\n');
    expect(parseCalendarCsv(`\uFEFF${text}`, EASTERN)).toEqual({
      events: [{ uid: 'evt-1', title: 'Holiday party', startDate: '2026-12-05', endDate: '2026-12-05', startTime: '19:00', endTime: '22:00', keyed: true }],
      skippedRepeating: 0,
      skippedRows: 0,
    });
  });

  it('reads an offset time as the town’s wall time across a DST change, and a Z time', () => {
    const text = csv([
      { id: 'summer', title: 'Summer supper', start: '2025-07-11T18:00:00-04:00', end: '2025-07-11T21:00:00-04:00' },
      { id: 'winter', title: 'Winter supper', start: '2025-01-10T18:00:00-05:00', end: '2025-01-10T21:00:00-05:00' },
      { id: 'utc', title: 'Brunch', start: '2025-03-01T15:30:00Z', end: '2025-03-01T17:00:00Z' },
    ]);
    expect(eventsOf(text).map(({ uid, startDate, startTime, endTime }) => ({ uid, startDate, startTime, endTime }))).toEqual([
      { uid: 'winter', startDate: '2025-01-10', startTime: '18:00', endTime: '21:00' },
      { uid: 'utc', startDate: '2025-03-01', startTime: '10:30', endTime: '12:00' },
      { uid: 'summer', startDate: '2025-07-11', startTime: '18:00', endTime: '21:00' },
    ]);
    // The same instants in a town an hour behind: the town fixes the wall time, the timezone column is not read.
    expect(eventsOf(text, CENTRAL).map((event) => event.startTime)).toEqual(['17:00', '09:30', '17:00']);
  });

  it('reads an offset-less midnight-to-midnight row as an all-day event of 1 or 14 days', () => {
    const text = csv([
      { id: 'one', title: 'Closed for inventory', start: '2024-06-01T00:00:00', end: '2024-06-02T00:00:00' },
      { id: 'fourteen', title: 'Kitchen renovation', start: '2024-08-04T00:00:00', end: '2024-08-18T00:00:00' },
      { id: 'three', title: 'Long weekend', start: '2024-06-07T00:00:00', end: '2024-06-10T00:00:00' },
    ]);
    expect(eventsOf(text)).toEqual([
      { uid: 'one', title: 'Closed for inventory', startDate: '2024-06-01', endDate: '2024-06-01', startTime: null, endTime: null, keyed: true },
      { uid: 'three', title: 'Long weekend', startDate: '2024-06-07', endDate: '2024-06-09', startTime: null, endTime: null, keyed: true },
      { uid: 'fourteen', title: 'Kitchen renovation', startDate: '2024-08-04', endDate: '2024-08-17', startTime: null, endTime: null, keyed: true },
    ]);
  });

  it('keeps an evening event ending at 01:00 on its start day with its hours, and a bare date as a date', () => {
    const text = csv([
      { id: 'late', title: 'Late party', start: '2025-03-07T21:00:00-05:00', end: '2025-03-08T01:00:00-05:00' },
      { id: 'dated', title: 'Market day', start: '2025-05-03', end: '2025-05-04' },
    ]);
    expect(eventsOf(text)).toEqual([
      { uid: 'late', title: 'Late party', startDate: '2025-03-07', endDate: '2025-03-07', startTime: '21:00', endTime: '01:00', keyed: true },
      { uid: 'dated', title: 'Market day', startDate: '2025-05-03', endDate: '2025-05-03', startTime: null, endTime: null, keyed: true },
    ]);
  });

  it('leaves out cancelled rows, imports each row of a repeating series, and suffixes blank and repeated ids, unkeyed', () => {
    const series = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22'].map((day, index) => ({
      id: `weekly_${String(index)}`, series: 'weekly', title: 'Trivia night', start: `${day}T19:00:00-05:00`, end: `${day}T21:00:00-05:00`,
    }));
    const text = csv([
      ...series,
      { id: 'gone', title: 'Called off', status: 'cancelled', start: '2026-12-02T18:00:00-05:00', end: '2026-12-02T20:00:00-05:00' },
      { id: '', title: 'No id', start: '2026-12-03T18:00:00-05:00', end: '2026-12-03T20:00:00-05:00' },
      { id: 'twice', title: 'First', start: '2026-12-04T18:00:00-05:00', end: '2026-12-04T20:00:00-05:00' },
      { id: 'twice', title: 'Second', start: '2026-12-05T18:00:00-05:00', end: '2026-12-05T20:00:00-05:00' },
    ]);
    const result = parseCalendarCsv(text, EASTERN);
    if ('error' in result) throw new Error('not a calendar CSV');
    expect(result.skippedRepeating).toBe(0);
    expect(result.events.map(({ uid, keyed }) => ({ uid, keyed }))).toEqual([
      { uid: 'weekly_0', keyed: true },
      { uid: 'event-6', keyed: false },
      { uid: 'twice', keyed: false },
      { uid: 'twice#8', keyed: false },
      { uid: 'weekly_1', keyed: true },
      { uid: 'weekly_2', keyed: true },
      { uid: 'weekly_3', keyed: true },
    ]);
  });

  it('never keys an id over 1,024 characters, and cuts a title over 200', () => {
    const long = 'k'.repeat(1_025);
    const text = csv([
      { id: long, title: 'T'.repeat(250), start: '2026-12-01T18:00:00-05:00', end: '2026-12-01T19:00:00-05:00' },
      { id: 'k'.repeat(1_024), title: '   ', start: '2026-12-02T18:00:00-05:00', end: '2026-12-02T19:00:00-05:00' },
    ]);
    const [first, second] = eventsOf(text);
    expect(first).toMatchObject({ uid: long, keyed: false, title: 'T'.repeat(200) });
    expect(second).toMatchObject({ keyed: true, title: 'Untitled event' });
  });

  it('skips and counts a row whose start cannot be read, keeping the others', () => {
    const text = csv([
      { id: 'good', title: 'Good', start: '2026-12-01T18:00:00-05:00', end: '2026-12-01T19:00:00-05:00' },
      { id: 'bad', title: 'Bad', start: 'next Tuesday', end: '2026-12-02T19:00:00-05:00' },
      { id: 'worse', title: 'Worse', start: '2026-02-30T18:00:00', end: '' },
    ]);
    const result = parseCalendarCsv(`${text}\r\n\r\n`, EASTERN);
    expect(result).toMatchObject({ skippedRows: 2, events: [{ uid: 'good' }] });
  });

  it('keeps no description, location, organizer email or Google URL anywhere in its result', () => {
    const text = csv([{
      id: 'private', title: 'Smith reunion', start: '2026-12-12T18:00:00-05:00', end: '2026-12-12T22:00:00-05:00',
      description: 'SENTINEL-DESCRIPTION call 603-555-0142', location: 'SENTINEL-LOCATION 1 Main St', organizer: 'sentinel.organizer@example.com',
      url: 'https://www.google.com/calendar/event?eid=SENTINEL-EID',
    }]);
    const kept = JSON.stringify(parseCalendarCsv(text, EASTERN));
    for (const sentinel of ['SENTINEL', '603-555', 'Main St', 'example.com', 'google.com', 'made-up-calendar']) expect(kept).not.toContain(sentinel);
    expect(kept).toContain('Smith reunion');
  });
});

describe('parseCalendarFile', () => {
  it('picks .ics by its VCALENDAR, the CSV profile by its header, and refuses anything else', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:i1', 'SUMMARY:From ics', 'DTSTART;VALUE=DATE:20261201', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    expect(parseCalendarFile(ics, EASTERN)).toMatchObject({ format: 'ics', skippedRows: 0, events: [{ uid: 'i1' }] });
    const text = csv([{ id: 'c1', title: 'From csv', start: '2026-12-01', end: '2026-12-02' }]);
    expect(parseCalendarFile(text, EASTERN)).toMatchObject({ format: 'csv', skippedRepeating: 0, events: [{ uid: 'c1' }] });
    expect(parseCalendarFile('date,guests,net_sales\n2026-11-01,120,2400.00\n', EASTERN)).toEqual({ error: 'not_calendar' });
    expect(parseCalendarFile('', EASTERN)).toEqual({ error: 'not_calendar' });
    expect(parseCalendarFile('event_id,title,start_at\nx,Party,2026-12-01\n', EASTERN)).toEqual({ error: 'not_calendar' });
    // A sales export with a title column is still not a calendar.
    expect(parseCalendarFile('date,title,guests\n2026-11-01,Friday,120\n', EASTERN)).toEqual({ error: 'not_calendar' });
  });
});

describe('a file calendar’s window (design decision 4)', () => {
  const allDay = (uid: string, day: string): IcsEvent => ({ uid, title: uid, startDate: day, endDate: day, startTime: null, endTime: null, keyed: true });

  it('keeps a file event 1,000 days back and drops one 1,100 days back, for either format', () => {
    const rows = [1_000, 1_100].map((back) => ({ id: `back-${String(back)}`, title: 'Old', start: plusDays(TODAY, -back), end: plusDays(TODAY, -back + 1) }));
    const fromCsv = parseCalendarFile(csv(rows), EASTERN);
    expect(fromCsv).toMatchObject({ events: [{ uid: 'back-1000' }] });
    expect('events' in fromCsv ? fromCsv.events : []).toHaveLength(1);
    const ics = ['BEGIN:VCALENDAR', ...[1_000, 1_100].flatMap((back) => [
      'BEGIN:VEVENT', `UID:back-${String(back)}`, 'SUMMARY:Old', `DTSTART;VALUE=DATE:${plusDays(TODAY, -back).replace(/-/g, '')}`, 'END:VEVENT',
    ]), 'END:VCALENDAR'].join('\r\n');
    const fromIcs = parseCalendarFile(ics, EASTERN);
    expect('events' in fromIcs ? fromIcs.events.map((event) => event.uid) : []).toEqual(['back-1000']);
    expect(FILE_HISTORY_DAYS).toBe(1_096);
  });

  it('keeps all 600 upcoming events of 2,500, then the latest 1,400 earlier ones', () => {
    const earlier = Array.from({ length: 1_900 }, (_, index) => allDay(`before-${String(index)}`, plusDays(TODAY, -1 - Math.floor(index / 2))));
    const upcoming = Array.from({ length: 600 }, (_, index) => allDay(`ahead-${String(index)}`, plusDays(TODAY, Math.floor(index / 2))));
    const kept = keepWindow([...earlier, ...upcoming], TODAY, { aheadFirst: true, historyDays: FILE_HISTORY_DAYS });
    expect(kept).toHaveLength(MAX_EVENTS);
    expect(kept.filter((event) => event.uid.startsWith('ahead-'))).toHaveLength(600);
    const keptEarlier = kept.filter((event) => event.uid.startsWith('before-'));
    expect(keptEarlier).toHaveLength(1_400);
    expect(keptEarlier.every((event) => event.startDate >= plusDays(TODAY, -700))).toBe(true);
  });

  it('keeps a link’s 400 days: 401 days back is dropped', () => {
    const kept = keepWindow([allDay('in', plusDays(TODAY, -WINDOW_DAYS)), allDay('out', plusDays(TODAY, -WINDOW_DAYS - 1))], TODAY);
    expect(kept.map((event) => event.uid)).toEqual(['in']);
  });
});
