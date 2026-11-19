import { render, screen } from '@testing-library/react-native';

import { AttachmentChip } from '../../src/chat/ui/AttachmentChip';

// A calendar file a person's message carries (spec D63), as its chip over their bubble on native: its name and
// "Calendar file", never "can't read". Fixtures are synthetic.

const REF = 'f_0123456789abcdef01234567';

it('names an attached .ics file a calendar file, linked to its item page', async () => {
  await render(<AttachmentChip attachment={{ ref: REF, kind: 'calendar', name: 'bookings.ics', state: 'on' }} locationId="l1" viewAs={false} />);
  expect(screen.getByText('bookings.ics')).toBeTruthy();
  expect(screen.getByText('Calendar file')).toBeTruthy();
  expect(screen.getByLabelText('bookings.ics, Calendar file. Open on Your data')).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toContain('can’t read');
});

it('names it by its kind alone under view-as', async () => {
  await render(<AttachmentChip attachment={{ ref: REF, kind: 'calendar', name: null, state: 'on' }} locationId="l1" viewAs />);
  expect(screen.getByText('Calendar file')).toBeTruthy();
});
