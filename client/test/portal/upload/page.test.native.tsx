jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, screen } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';

// P13 on iOS and Android: upload is web only (D20), so the page says where to upload and offers no file control.

afterEach(async () => {
  await cleanup();
});

test('native shows where to upload instead of the upload', async () => {
  await renderApp('/locations/l1/sales/upload', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') }));
  expect(await screen.findByText('Upload from a computer at townwise.tech.')).toBeTruthy();
  expect(screen.getByText('Upload sales history')).toBeTruthy();
  expect(screen.queryByText('Choose a CSV file')).toBeNull();
});
