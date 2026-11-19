import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';

import { AttachmentChip } from '../../src/chat/ui/AttachmentChip';

// A calendar file a person's message carries (spec D63), as its chip over their bubble on web: its name and
// "Calendar file", never "can't read", linked to its item page. Fixtures are synthetic.

const REF = 'f_0123456789abcdef01234567';

afterEach(cleanup);

it('names an attached .ics file a calendar file, linked to its item page', async () => {
  render(
    <ExpoRoot
      context={getMockContext({
        index: () => <AttachmentChip attachment={{ ref: REF, kind: 'calendar', name: 'bookings.ics', state: 'on' }} locationId="l1" viewAs={false} />,
      })}
    />,
  );
  const link = await screen.findByRole('link', { name: 'bookings.ics, Calendar file. Open on Your data' });
  expect(link.getAttribute('href')).toBe(`/locations/l1/data/${REF}`);
  expect(link.textContent).toBe('bookings.icsCalendar file');
  expect(document.body.textContent).not.toContain('can’t read');
});
