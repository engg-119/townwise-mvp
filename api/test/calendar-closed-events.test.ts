// D59 slice 5 (openspec change auto-apply-agent-reads design decision 16): which calendar events plainly say the business
// is closed (src/calendar/closed-events.ts): a keyed all-day event whose folded title is "closed", optionally after a few
// words naming the business, followed by nothing that names part of a day or of the place, a booking, doubt or opening,
// with no `?` or digit, and whose dates make a closure note. Every title here is made up.
import { describe, expect, it } from 'vitest';

import { closedDaysOf, closedEventsOf, closureNoteOfEvent, plainlyClosed, type CalendarEvent } from '../src/calendar/closed-events.ts';

const TODAY = '2026-06-01';

function event(title: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    calendarId: 'c'.repeat(24), uid: `uid-${title}`, title, startDate: '2026-06-13', endDate: '2026-06-13', startTime: null, endTime: null,
    keyed: true, ...extra,
  };
}

describe('plainlyClosed', () => {
  it.each([
    'Closed', 'CLOSED', 'closed for Thanksgiving', 'We’re closed', "We're closed", 'We are closed', 'Closed (family vacation)',
    'Closed - staff retreat', 'Restaurant closed', 'Café closed', 'Store closed for inventory', 'Closed today', 'Closed all day',
    '  closed  ', 'Closed for the holidays',
  ])('%s plainly says closed', (title) => {
    expect(plainlyClosed(title)).toBe(true);
  });

  it.each([
    'Closed early', 'Closed 2-5pm', 'Closed at 3', 'Kitchen closed', 'Bar closed', 'Patio closed', 'Closed for a private party',
    'Closed for private event', 'Closed to the public', 'Closed?', 'Maybe closed', 'Not closed', 'Closed until noon',
    'Closed for lunch', 'Closed, open for dinner', 'Reopening', 'Open', 'Staff meeting', 'Close books', 'Closing shift', '',
    'Closed for the Smith wedding', 'Tentatively closed', 'Closed except takeout', 'Closed but delivery', 'Closed upstairs',
    'Holiday: closed', 'Closed Dec 25',
  ])('%s does not', (title) => {
    expect(plainlyClosed(title)).toBe(false);
  });
});

describe('closedEventsOf', () => {
  it('keeps keyed all-day closed events whose dates make a closure note', () => {
    const kept = event('Closed', { uid: 'kept' });
    const events = [
      kept,
      event('Closed', { uid: 'timed', startTime: '09:00', endTime: '12:00' }),
      event('Closed', { uid: 'unkeyed', keyed: false }),
      event('Closed early', { uid: 'early' }),
      // Section 12: a note spans at most 366 days.
      event('Closed', { uid: 'long', startDate: '2026-06-01', endDate: '2027-06-10' }),
    ];
    expect(closedEventsOf(events, TODAY).map((each) => each.uid)).toEqual(['kept']);
  });

  it('maps each day to the closed events covering it', () => {
    const a = event('Closed', { uid: 'a', startDate: '2026-06-13', endDate: '2026-06-15' });
    const b = event('Closed for inventory', { uid: 'b', startDate: '2026-06-15', endDate: '2026-06-15' });
    const days = closedDaysOf([a, b]);
    expect([...days.keys()]).toEqual(['2026-06-13', '2026-06-14', '2026-06-15']);
    expect(days.get('2026-06-15')?.map((each) => each.uid)).toEqual(['a', 'b']);
  });

  it('makes a closure note with no title and the event’s dates', () => {
    expect(closureNoteOfEvent(event('Closed for Thanksgiving', { startDate: '2026-11-26', endDate: '2026-11-27' }), TODAY)).toEqual({
      kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-27', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
      title: null, startTime: null, endTime: null,
    });
  });
});
