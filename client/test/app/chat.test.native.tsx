jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, screen, waitFor } from 'expo-router/testing-library';

import { STOPPED } from '../../src/chat/useTuningChat';
import { fakeChatApi, PROPOSAL, SUMMARY, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';

afterEach(async () => {
  await cleanup();
});

// The chat inside the portal, as it ships: it calls the portal's api, which answers /api/me and /api/org and passes
// the chat's own routes to `api`.
async function renderChat(api: FakeChatApi) {
  const { router } = await renderApp('/locations/l1/chat', fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: api }));
  await screen.findAllByRole('heading', { name: 'Main Street Bar' });
  return router;
}

function turn(api: FakeChatApi): LiveTurn {
  const live = api.turns.at(-1);
  if (live === undefined) throw new Error('no turn');
  return live;
}

async function send(text: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Message'), text);
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
}

test('shows the location, its conversations and a labelled composer', async () => {
  await renderChat(fakeChatApi());
  // The location header's and the chat's own.
  expect(screen.getAllByRole('heading', { name: 'Main Street Bar' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Back to locations' })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Earlier chat, Nov 2, 2026$/ })).toBeTruthy();
  expect(screen.getByLabelText('Message')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' }).props.accessibilityState).toMatchObject({ disabled: true });
});

test('off: says the chat isn’t turned on yet, with no composer', async () => {
  const api = fakeChatApi();
  api.summary = { ...SUMMARY, enabled: false };
  await renderChat(api);
  expect(screen.getByText('The tuning chat isn’t turned on yet.')).toBeTruthy();
  expect(screen.queryByLabelText('Message')).toBeNull();
});

test('budget used up: says so in place of the composer', async () => {
  const api = fakeChatApi();
  api.summary = { ...SUMMARY, budget: { ...SUMMARY.budget, exhausted: true } };
  await renderChat(api);
  expect(screen.getByText('This month’s chat budget is used up. The chat opens again next month.')).toBeTruthy();
  expect(screen.queryByLabelText('Message')).toBeNull();
  expect(screen.getByRole('button', { name: /^Earlier chat/ })).toBeTruthy();
});

test('a reply streams in with a tool status, and its proposal card adds a note in plain words', async () => {
  const api = fakeChatApi();
  await renderChat(api);
  await send('Private party on Mondays in March');
  expect(screen.getByText('Private party on Mondays in March')).toBeTruthy();
  expect(screen.getByText('Thinking')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  await act(() => { turn(api).emit('tool', { name: 'get_sales_days', state: 'running' }); });
  expect(screen.getByText('Reading sales history')).toBeTruthy();
  await act(() => {
    turn(api).emit('tool', { name: 'get_sales_days', state: 'done' });
    turn(api).emit('text', { delta: 'Mondays in March are usually slow.' });
    turn(api).emit('proposal', {
      proposal: {
        ...PROPOSAL, kind: 'private_event', startDate: '2027-03-01', endDate: '2027-03-29', weekdays: [1],
        effect: 'more_guests', expectedGuests: 1200, detail: 'A rehearsal dinner.',
      },
    });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0.01 });
    turn(api).end();
  });
  expect(screen.queryByText('Reading sales history')).toBeNull();
  expect(screen.getByText('Mondays in March are usually slow.')).toBeTruthy();
  for (const text of ['Private event', 'March 1, 2027 to March 29, 2027', 'Mondays only', 'More guests than usual', 'About 1,200 guests', 'A rehearsal dinner.']) {
    expect(screen.getByText(text)).toBeTruthy();
  }
  await fireEvent.press(screen.getByRole('button', { name: 'Add note' }));
  expect(await screen.findByText('Note added.')).toBeTruthy();
  expect(api.requests[0]?.path).toBe('/api/org/locations/l1/notes');
  expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
});

test('an Add note refusal shows the API’s reason on the card, and Dismiss hides the card', async () => {
  const api = fakeChatApi();
  await renderChat(api);
  await send('Holidays');
  await act(() => {
    turn(api).emit('proposal', { proposal: PROPOSAL });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  expect(screen.getByText('Closure')).toBeTruthy();
  expect(screen.getByText('December 24, 2026 to December 26, 2026')).toBeTruthy();
  api.noteResult = () => Promise.reject(new Error('offline'));
  await fireEvent.press(screen.getByRole('button', { name: 'Add note' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('Couldn’t save the note. Try again.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Closure')).toBeNull();
});

test('Stop keeps the partial reply, marked stopped, and Send comes back', async () => {
  const api = fakeChatApi();
  await renderChat(api);
  await send('Hello');
  await act(() => { turn(api).emit('text', { delta: 'Half a rep' }); });
  await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
  expect(await screen.findByText(STOPPED)).toBeTruthy();
  expect(screen.getByText('Half a rep')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
});

test('a past conversation opens; New conversation returns to the list', async () => {
  await renderChat(fakeChatApi());
  await fireEvent.press(screen.getByRole('button', { name: /^Earlier chat/ }));
  expect(await screen.findByText('We close for the holidays.')).toBeTruthy();
  expect(screen.getByText('Closure')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'New conversation' }));
  await waitFor(() => { expect(screen.queryByText('We close for the holidays.')).toBeNull(); });
  expect(screen.getByRole('button', { name: /^Earlier chat/ })).toBeTruthy();
});

test('Back to locations goes to the dashboard', async () => {
  const router = await renderChat(fakeChatApi());
  await fireEvent.press(screen.getByRole('button', { name: 'Back to locations' }));
  expect(router.getPathname()).toBe('/dashboard');
});
