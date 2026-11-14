import { CalendarPage } from '../../../../../../src/portal/calendar/CalendarPage';

// P28 Calendar (/locations/[locationId]/calendar, members): docs/portal/spec.md 16.3. The page lives in
// src/portal/calendar/; `?day=YYYY-MM-DD` selects a day, so Home's This month can open it at one.
export default function CalendarTab(): React.JSX.Element {
  return <CalendarPage />;
}
