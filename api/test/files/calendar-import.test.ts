// What makes a stored file a calendar file to Your data's import (D60, src/files/calendar-import.ts), and the label its
// calendar takes from the file's name, as Your calendars words it. Made-up names only.
import { describe, expect, it } from 'vitest';

import { calendarCandidate, RETRYABLE_IMPORTS } from '../../src/files/calendar-import.ts';
import { labelOfFile } from '../../src/handlers/owner-calendars.ts';

const bytes = (text: string): Uint8Array => Buffer.from(text, 'utf8');

describe('calendarCandidate', () => {
  it('an .ics or .ical file whose text starts a VCALENDAR is a calendar, after a byte-order mark or blank lines, in any case', () => {
    expect(calendarCandidate('Bookings.ics', 'other', bytes('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'))).toBe('calendar');
    expect(calendarCandidate('bookings.ICAL', 'other', bytes('\uFEFF\r\n  begin:vcalendar\r\n'))).toBe('calendar');
  });

  it('an .ics or .ical file that does not start a VCALENDAR is named a calendar but is not one', () => {
    expect(calendarCandidate('broken.ics', 'other', bytes('Not a calendar'))).toBe('named');
    expect(calendarCandidate('later.ics', 'other', bytes('Notes first\r\nBEGIN:VCALENDAR\r\n'))).toBe('named');
    expect(calendarCandidate('cal.ical', 'other', bytes('BEGIN:VCALENDARX'))).toBe('named');
  });

  it('a text file is a calendar only when its header is a calendar CSV export', () => {
    expect(calendarCandidate('export.csv', 'text', bytes('event_id,title,start_at,end_at\r\n1,Dinner,2026-06-12,2026-06-12\r\n'))).toBe('calendar');
    expect(calendarCandidate('export.csv', 'text', bytes('\uFEFFTitle;Start_At;End_At;Event_ID;Status\n'))).toBe('calendar');
    expect(calendarCandidate('sales.csv', 'text', bytes('date,guests,net_sales\r\n2026-06-01,40,1200\r\n'))).toBeNull();
    expect(calendarCandidate('notes.txt', 'text', bytes('BEGIN:VCALENDAR\r\n'))).toBeNull();
  });

  it('any other file is left alone, a CSV header in a file that is not text included', () => {
    expect(calendarCandidate('menu.pdf', 'pdf', bytes('%PDF-1.4'))).toBeNull();
    expect(calendarCandidate('export.xlsx', 'xlsx', bytes('event_id,title,start_at,end_at'))).toBeNull();
  });
});

describe('labelOfFile', () => {
  it('drops a final .ics, .ical or .csv, trims, and holds 60 code units without splitting a surrogate pair', () => {
    expect(labelOfFile('Front desk.ics')).toBe('Front desk');
    expect(labelOfFile('  Private parties .ICAL')).toBe('Private parties');
    expect(labelOfFile('master.calendar.csv')).toBe('master.calendar');
    expect(labelOfFile('notes.txt')).toBe('notes.txt');
    expect(labelOfFile(`${'a'.repeat(59)}😀.ics`)).toBe('a'.repeat(59));
    expect(labelOfFile('x'.repeat(80))).toHaveLength(60);
  });

  it('names a file with nothing left "Calendar file"', () => {
    expect(labelOfFile('.ics')).toBe('Calendar file');
    expect(labelOfFile('   .csv')).toBe('Calendar file');
  });
});

it('only a full location and an unreadable original can be retried', () => {
  expect([...RETRYABLE_IMPORTS].sort()).toEqual(['calendar_limit', 'unavailable']);
});
