import { gridRange } from '../../../src/portal/calendar/grid';
import { ALL_FILTERS, monthBounds, type CalendarInput, type ImportedEvent } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import { holiday, note, townEvent } from '../analytics/fakes';
import { ruleOf } from '../rules/fakes';
import { forecastDay, forecastOf } from './fakes';

// One fixture day for every compact surface (D49, day-entries "One fixture day on every surface"), shared by
// entries-parity.test.ts (the Calendar's) and test/portal/home/week.test.ts (Home's This week). Every name is made up.

export const PARITY_TODAY = '2026-11-11';
export const PARITY_DAY = '2026-11-21';

function imported(fields: Partial<ImportedEvent> & Pick<ImportedEvent, 'title' | 'uid'>): ImportedEvent {
  return { calendarId: 'c1', calendar: 'US holidays', startDate: PARITY_DAY, endDate: PARITY_DAY, startTime: null, endTime: null, ...fields };
}

/** A day with a titled note, a rule, a holiday the owner's calendar repeats, a town event and two events of one calendar. */
export function parityInput(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: PARITY_TODAY, covered: gridRange('2026-11', monthBounds(PARITY_TODAY)),
    forecast: forecastOf([forecastDay({ date: PARITY_DAY, reasons: [] })]) as ForecastWindow, salesDays: [],
    events: [townEvent({ start: PARITY_DAY, title: 'Craft fair' }), holiday(PARITY_DAY, 'Made-up Day', 'us:madeup', 'Made-up Day')],
    notes: [note({ startDate: PARITY_DAY, title: 'Holiday party', expectedGuests: 70 })],
    rules: [ruleOf('r1', 'Patio closes at 8 pm', {
      schedule: { kind: 'other', startDate: '2026-11-01', endDate: null, weekdays: [6], effect: 'unknown', expectedGuests: null, startTime: null, endTime: null },
    })],
    imported: [
      imported({ title: 'made-up  day', uid: 'm1' }),
      imported({ title: 'Private party', uid: 'p1', startTime: '12:00', endTime: '14:00' }),
      imported({ title: 'Private party', uid: 'p2', startTime: '18:00', endTime: '21:00' }),
    ],
    filters: ALL_FILTERS,
    ...fields,
  };
}

/** The compact order every surface shares, before its limit. */
export const PARITY_ORDER = ['Holiday party', 'Patio closes at 8 pm', 'Made-up Day', 'Craft fair', 'Private party', 'Private party'];
