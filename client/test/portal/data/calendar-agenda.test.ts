import { agendaMonths, calendarEventItem, emptyMonthLine, fileEventItem } from '../../../src/portal/data/item/agenda';

// The calendar agenda of Your data (D49, calendar-detail): a calendar's events, or what TownwiseAI read from a
// calendar file, grouped by month in date order, each linking to its day on the Calendar. Made-up titles only.

const VETERANS = {
  calendarId: 'c1', calendar: 'US holidays', uid: 'v1', title: 'Veterans Day', startDate: '2026-11-11', endDate: '2026-11-11', startTime: null, endTime: null,
};
const DINNER = { ...VETERANS, uid: 'd1', title: 'Rehearsal dinner', startDate: '2026-12-12', endDate: '2026-12-12', startTime: '18:00', endTime: '21:00' };
const FAIR = { ...VETERANS, uid: 'f1', title: 'Craft fair', startDate: '2026-11-20', endDate: '2026-11-22' };

test('a calendar’s events group by month in date order, each with its day, hours and a link to that day', () => {
  const months = agendaMonths([DINNER, FAIR, VETERANS].map((event) => calendarEventItem('l1', event)));
  expect(months.map((month) => [month.label, month.items.map((item) => item.title)])).toEqual([
    ['November 2026', ['Veterans Day', 'Craft fair']],
    ['December 2026', ['Rehearsal dinner']],
  ]);
  const [veterans, fair] = months[0]?.items ?? [];
  // No “Your calendar” line: the page is that calendar's (UI review nit 5).
  expect(veterans).toMatchObject({ when: 'Wed, Nov 11, 2026', hours: null, href: '/locations/l1/calendar?day=2026-11-11', status: null, sub: null });
  expect(veterans?.label).toBe('Veterans Day, Wed, Nov 11, 2026. Opens the day on the Calendar.');
  expect(fair?.when).toBe('Nov 20 to 22, 2026');
  expect(months[1]?.items[0]).toMatchObject({ hours: '6 pm to 9 pm', kind: 'imported' });
});

test('on a calendar’s page, an event that began the month before lists under the month shown (D49)', () => {
  const across = { ...VETERANS, uid: 'a1', title: 'Harvest weekend', startDate: '2026-10-30', endDate: '2026-11-02' };
  const months = agendaMonths([FAIR, across].map((event) => calendarEventItem('l1', event)), '2026-11');
  expect(months.map((month) => [month.label, month.items.map((item) => item.title)])).toEqual([['November 2026', ['Harvest weekend', 'Craft fair']]]);
});

test('a file’s read: an event that became a note links to its day, marked Note made; any other reads No note made', () => {
  const made = { title: 'Rehearsal dinner', startDate: '2026-12-12', endDate: '2026-12-12', kind: 'private_event', effect: 'closed', expectedGuests: 60, noteId: 'n1' } as const;
  const skipped = { ...made, title: 'Staff party', startDate: '2026-12-03', endDate: '2026-12-03', kind: 'other', effect: 'unknown', expectedGuests: null, noteId: null } as const;
  const months = agendaMonths([made, skipped].map((event, at) => fileEventItem('l1', event, at)));
  expect(months.map((month) => month.items.map((item) => [item.title, item.sub, item.status, item.href]))).toEqual([[
    ['Staff party', 'Other', 'No note made', null],
    ['Rehearsal dinner', 'Private buyout, 60 guests', 'Note made', '/locations/l1/calendar?day=2026-12-12'],
  ]]);
  // Under view-as a title is null: the event shows its kind words in its place, once (UI review nit 8).
  expect(fileEventItem('l1', { ...made, title: null }, 0)).toMatchObject({ title: 'Private buyout, 60 guests', sub: null });
});

test('an empty month says so', () => {
  expect(emptyMonthLine('2027-02')).toBe('No events in February 2027.');
  expect(agendaMonths([])).toEqual([]);
});
