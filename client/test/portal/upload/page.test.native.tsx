jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { cleanup, screen } from 'expo-router/testing-library';

import { ChoiceGroup } from '../../../src/portal/upload/ChoiceGroup';
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

test('a choice button shrinks to its row and wraps its label, so the date order fits at 320px', async () => {
  const label = 'Month first (03/04/2025 is March 4, 2025)';
  await render(<ChoiceGroup legend="Date order" value="month_first" choices={[{ value: 'month_first', label }]} onChange={() => undefined} />);
  expect(StyleSheet.flatten(screen.getByRole('button', { name: label }).props.style)).toMatchObject({ flexShrink: 1, maxWidth: '100%' });
});
