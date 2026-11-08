import { render, screen } from '@testing-library/react-native';

import { SetupUpload } from '../../../src/portal/console/SetupUpload';

// The setup upload on native (spec 16.4 P21, D20): daily totals are read on a computer, so native says so and offers
// no file control. The web version is SetupUpload.web.tsx (setup.test.web.tsx).

test('native says to upload from a computer, with nothing to choose', async () => {
  const location = {
    id: 'l1', name: 'Hanover', town: { townId: 'hanover-nh', name: 'Hanover', state: 'NH' },
    coverage: { dayCount: 0, firstDate: null, lastDate: null }, notesCount: 0, lastUploadAt: null,
  };
  await render(
    <SetupUpload
      org={{ id: 'o1', name: 'Sample Restaurant Group' }}
      locations={[location]}
      settled={() => Promise.resolve(false)}
      onSaved={() => Promise.resolve(true)}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Upload daily totals' })).toBeTruthy();
  expect(screen.getByText('Upload daily totals for Sample Restaurant Group from a computer.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
