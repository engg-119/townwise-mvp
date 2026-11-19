import { firstDay } from '../../../src/portal/town/EventItem';

// The Calendar day a Town tab event links to (D66 task 7.3): the first day in the range the event is on, its weekdays
// honored as on the Calendar (calendar/entries.ts foundCovers), so a season that began months ago is not linked to its
// start and a weekly event whose days miss the range is not listed.

const event = (start: string, end: string, weekdays: number[] | null = null) => ({ start, end, weekdays });

test('an event starting in the range links to its start', () => {
  expect(firstDay(event('2026-11-21', '2026-11-22'), '2026-11-19', '2026-11-25')).toBe('2026-11-21');
});

test('a season that began before the range links to the range’s first day', () => {
  expect(firstDay(event('2026-06-01', '2027-03-31'), '2026-11-19', '2026-11-25')).toBe('2026-11-19');
});

test('weekdays: the first of its days in the range, or null when none falls in it', () => {
  // 2026-11-19 is a Thursday; Saturdays (6) only.
  expect(firstDay(event('2026-06-01', '2027-03-31', [6]), '2026-11-19', '2026-11-25')).toBe('2026-11-21');
  // Ends Monday the 23rd, Fridays and Saturdays only, read from the Sunday: none left.
  expect(firstDay(event('2026-11-01', '2026-11-23', [5, 6]), '2026-11-22', '2026-11-28')).toBeNull();
  // Inside the dates but past the range's end.
  expect(firstDay(event('2026-11-20', '2026-12-31', [3]), '2026-11-19', '2026-11-24')).toBeNull();
});
