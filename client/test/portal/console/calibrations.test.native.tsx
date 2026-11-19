jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});

import { fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../../../src/api/client';
import { Calibrations } from '../../../src/portal/console/CalibrationsPanel';
import { fakePortalApi, staffMe } from '../../helpers/portal';
import { portalWrapper } from '../files/harness';
import { orgDetail } from './fixtures';

// The Calibrations part's words on native (2026-11-19): the Calibrate dialog says which engine runs from how much
// history, and a start refused for too little history says the baseline's 230 days and the model's 595. The web
// version is calibrations.test.web.tsx. Every figure is synthetic.

const START = '/api/admin/orgs/o1/locations/l1/calibrations';
const DETAIL = orgDetail();

async function open(): Promise<ReturnType<typeof fakePortalApi>> {
  const api = fakePortalApi({ me: staffMe() });
  const Wrapper = portalWrapper(api, staffMe());
  await render(
    <Wrapper>
      <Calibrations org={DETAIL.org} locations={DETAIL.locations} calibrations={[]} onStarted={() => Promise.resolve()} />
    </Wrapper>,
  );
  await fireEvent.press(await screen.findByRole('button', { name: 'Calibrate Hanover' }));
  return api;
}

test('the dialog says which engine runs from how much history, and its cost', async () => {
  await open();
  expect(screen.getByText(`Townwise refits Hanover’s forecast on its sales history and notes, on Townwise’s servers, and scores it on held-out weeks. With 595 days of sales history or more it runs Townwise’s demand model beside its baseline, as the weekly refresh does; with 230 to 594 days it runs the baseline only, unless the current forecast is from the demand model, which then needs 595 days. It costs $0.10 of ${DETAIL.org.name}’s TownwiseAI budget. If it passes every check and forecasts are on, it publishes itself. Its admins see this in their Townwise staff activity.`)).toBeTruthy();
});

test('a start refused for too little history says the baseline’s 230 days and the model’s 595', async () => {
  const api = await open();
  api.answers[START] = () => new ApiError('http', 'The request was refused.', { status: 409, code: 'not_enough_history' });
  await fireEvent.press(screen.getByRole('button', { name: 'Calibrate' }));
  expect(await screen.findByText('Calibration needs at least 230 days from the first to the last day of sales history, for Townwise’s baseline. Its demand model also runs from 595 days, which a location needs while its current forecast is from the demand model.')).toBeTruthy();
  expect(api.calls.filter((call) => call.method === 'POST')).toEqual([{ method: 'POST', path: START, body: {} }]);
});
