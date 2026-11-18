jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { AccessibilityInfo, StyleSheet } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { ACCESS, fakePortalApi, meOf, orgOf, writes } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';
import { ruleOf, rulesFake } from './fakes';

// P29 Business rules on native (spec 16.3): the same page, with the Add rule button submitting and every touch
// target at least 44px.

afterEach(async () => {
  await cleanup();
});

const PATH = '/api/org/locations/l1/rules';

function minHeightOf(element: { props: { style?: unknown } }): number {
  return (StyleSheet.flatten(element.props.style as object) as { minHeight?: number }).minHeight ?? 0;
}

test('lists, adds and deletes a rule with 44px targets', async () => {
  const fake = rulesFake([ruleOf('r1', 'Closed Mondays'), ruleOf('r2', 'Patio opens in May', { addedVia: 'townwise_ai' })]);
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  await renderApp('/locations/l1/rules', api);
  expect(await screen.findByText('Closed Mondays')).toBeTruthy();
  expect(screen.getByText('Patio opens in May')).toBeTruthy();
  expect(screen.getByText(/^Saved from TownwiseAI by /)).toBeTruthy();
  expect(screen.getByText('2 of 30')).toBeTruthy();

  const field = screen.getByLabelText('New rule');
  expect(minHeightOf(field)).toBeGreaterThanOrEqual(44);
  for (const name of ['Add rule', 'Edit “Closed Mondays”', 'Delete “Closed Mondays”']) {
    expect(minHeightOf(screen.getByRole('button', { name }))).toBeGreaterThanOrEqual(44);
  }
  for (const name of ['Open Notes', 'Ask TownwiseAI']) {
    expect(minHeightOf(screen.getByRole('link', { name }))).toBeGreaterThanOrEqual(44);
  }

  await fireEvent.changeText(field, 'Kitchen closes at 9');
  await fireEvent.press(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('Kitchen closes at 9')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: PATH, body: { text: 'Kitchen closes at 9' } }]);

  await fireEvent.press(screen.getByRole('button', { name: 'Delete “Closed Mondays”' }));
  const dialogButton = screen.getAllByRole('button', { name: 'Delete rule' }).at(-1);
  if (dialogButton === undefined) throw new Error('no Delete rule');
  await fireEvent.press(dialogButton);
  expect(await screen.findByText('Deleted the rule.')).toBeTruthy();
  expect(screen.queryByText('Closed Mondays')).toBeNull();
  expect(within(screen.getByLabelText('Business rules')).getAllByText(/^(Patio opens in May|Kitchen closes at 9)$/)).toHaveLength(2);
  expect(writes(api).at(-1)).toEqual({ method: 'DELETE', path: `${PATH}/r1`, body: undefined });
});

test('a rule’s schedule: Change the forecast opens the note form’s fields with 44px targets, and Add rule sends the schedule', async () => {
  const fake = rulesFake([ruleOf('r1', 'Closed Mondays', {
    schedule: { kind: 'closure', startDate: '2027-01-05', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    scheduleSummary: 'Closed on Mondays from Jan 5, 2027',
  })]);
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  await renderApp('/locations/l1/rules', api);
  expect(await screen.findByText('Changes the forecast: Closed on Mondays from Jan 5, 2027')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('New rule'), 'Closed Tuesdays');
  const open = screen.getByRole('button', { name: 'Change the forecast' });
  expect(minHeightOf(open)).toBeGreaterThanOrEqual(44);
  await fireEvent.press(open);
  for (const name of ['Closure', 'Tuesday', 'Remove from the forecast']) {
    expect(minHeightOf(screen.getByRole('button', { name }))).toBeGreaterThanOrEqual(44);
  }
  await fireEvent.changeText(screen.getByLabelText('Starts'), '2026-12-01');
  await fireEvent.press(screen.getByRole('button', { name: 'Tuesday' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('Closed Tuesdays')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: PATH, body: {
      text: 'Closed Tuesdays',
      schedule: { kind: 'closure', startDate: '2026-12-01', endDate: null, weekdays: [2], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
    },
  }]);
});

test('Every year (D46) is a 44px checkbox, and Add rule sends the season with no end', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: rulesFake([]) });
  await renderApp('/locations/l1/rules', api);
  await fireEvent.changeText(await screen.findByLabelText('New rule'), 'Closed over the holidays');
  await fireEvent.press(screen.getByRole('button', { name: 'Change the forecast' }));
  const box = screen.getByRole('checkbox', { name: 'Every year' });
  expect(minHeightOf(box)).toBeGreaterThanOrEqual(44);
  await fireEvent.press(box);
  expect(screen.getByRole('checkbox', { name: 'Every year' }).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByText('Closes the same days every year from Starts on, until you delete the rule.')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Starts'), '2026-12-20');
  await fireEvent.changeText(screen.getByLabelText('Ends'), '2027-01-05');
  await fireEvent.press(screen.getByRole('button', { name: 'Add rule' }));
  expect(await screen.findByText('Closed over the holidays')).toBeTruthy();
  expect(writes(api)).toEqual([{
    method: 'POST', path: PATH, body: {
      text: 'Closed over the holidays',
      schedule: {
        kind: 'closure', startDate: '2026-12-20', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
        season: { repeat: 'yearly', from: '12-20', to: '01-05' },
      },
    },
  }]);
});

test('the pressed control goes, so the screen reader moves: to the section’s heading on Change the forecast, to the line under its button on Remove', async () => {
  const send = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent');
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: rulesFake([ruleOf('r1', 'Closed Mondays')]) });
  await renderApp('/locations/l1/rules', api);
  expect(await screen.findByText('Closed Mondays')).toBeTruthy();
  // The page's own moves (the shell's, on arrival) are not this section's.
  const before = send.mock.calls.length;
  await fireEvent.press(screen.getByRole('button', { name: 'Change the forecast' }));
  expect(send.mock.calls.slice(before).map((call) => call[1])).toEqual(['focus']);
  await fireEvent.press(screen.getByRole('button', { name: 'Remove from the forecast' }));
  expect(send.mock.calls.slice(before).map((call) => call[1])).toEqual(['focus', 'focus']);
  send.mockRestore();
});
