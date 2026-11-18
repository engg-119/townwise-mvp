jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-secure-store');
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Dimensions } from 'react-native';
import { cleanup, fireEvent, screen, within } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { resetVersionFocus } from '../../src/chat/ui/VersionNav';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import type { MeResponse } from '../../src/portal/schemas';
import { fakeChatApi, type FakeChatApi } from '../helpers/chat';
import { ACCESS, fakePortalApi, meOf, orgOf } from '../helpers/portal';
import { renderApp } from '../helpers/renderApp';
import { serveAbout } from './about-fakes';

// TownwiseAI's weekly suggestions in P25's sheet on a phone (openspec change weekly-forecast-suggestions): members see
// the cards and the switch's state with no buttons; an org admin accepts one and the card says what it did, and turns
// the switch off.

const fixture = JSON.parse(readFileSync(join(__dirname, 'agent-panel.json'), 'utf8')) as {
  panel: { questions: unknown[]; activity: unknown[]; suggestions: unknown[]; weeklySuggestions: Record<string, boolean> };
};

const NOTE_HEADING = 'Closed on Sat, Jul 4, 2026?';

/** A card, by its question: the nearest element around its heading that holds an Accept. */
function cardOf(heading: string): ReturnType<typeof screen.getByRole> {
  let node = screen.getByRole('heading', { name: heading });
  while (node.parent !== null && within(node).queryAllByRole('button', { name: 'Accept' }).length === 0) node = node.parent;
  return node;
}

afterEach(async () => {
  await cleanup();
  resetDrafts();
  resetProfiles();
  resetVersionFocus();
  jest.restoreAllMocks();
});

const WINDOW = Dimensions.get('window');

async function renderSheet(me: MeResponse, canChange: boolean): Promise<FakeChatApi> {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
  const chat = fakeChatApi();
  chat.panel = { ...fixture.panel, weeklySuggestions: { ...fixture.panel.weeklySuggestions, available: true, canChange } };
  serveAbout(chat);
  const role = me.access.state === 'member' ? me.access.role : 'member';
  await renderApp('/locations/l1/agent?panel=questions', fakePortalApi({ me, org: orgOf(role), fallback: chat }));
  expect(await screen.findByRole('heading', { name: 'Questions and activity' })).toBeTruthy();
  return chat;
}

test('members see the suggestions and whether the switch is on, with no Accept, Dismiss or switch button', async () => {
  await renderSheet(meOf(ACCESS.member), false);
  const side = screen.getByTestId('agent-side');
  expect(await within(side).findByRole('heading', { name: NOTE_HEADING })).toBeTruthy();
  expect(within(side).getByText('Independence Day is Sat, Jul 4, and you were closed on it last year.')).toBeTruthy();
  expect(within(side).queryByRole('button', { name: 'Accept' })).toBeNull();
  expect(within(side).getByText('Weekly suggestions are on.')).toBeTruthy();
  expect(within(side).queryByRole('button', { name: 'Turn off weekly suggestions' })).toBeNull();
});

test('an org admin accepts a suggestion and turns weekly suggestions off', async () => {
  const api = await renderSheet(meOf(ACCESS.admin), true);
  const accept = '/api/org/locations/l1/agent/suggestions/0000000000000000000000c1/accept';
  api.respond[accept] = () => ({ suggestion: { id: '0000000000000000000000c1', status: 'accepted' }, note: null, rule: null });
  api.respond['/api/org/weekly-suggestions'] = () => ({ weeklySuggestions: { on: false } });
  await screen.findByRole('heading', { name: NOTE_HEADING });
  await fireEvent.press(within(cardOf(NOTE_HEADING)).getByRole('button', { name: 'Accept' }));
  expect(await screen.findByText('Saved a note: Closure, Sat, Jul 4, 2026.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Turn off weekly suggestions' }));
  expect(await screen.findByText('Weekly suggestions are off.')).toBeTruthy();
  expect(api.writes.map((write) => write.path)).toEqual([accept, '/api/org/weekly-suggestions']);
});

test('a note suggestion of kind other asks its effect, and shows its guests and hours and its detail as written', async () => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ ...WINDOW, width: 375 });
  const chat = fakeChatApi();
  chat.panel = {
    ...fixture.panel, weeklySuggestions: { ...fixture.panel.weeklySuggestions, available: true, canChange: true },
    suggestions: [{
      id: '0000000000000000000000c3', why: 'Winter term starts Fri, Jan 8, and your January weeks rose with it last year.', calendar: [],
      createdAt: '2026-11-16T06:00:00.000Z', type: 'note',
      note: {
        kind: 'other', startDate: '2027-01-08', endDate: '2027-01-10', weekdays: null, effect: 'more_guests', expectedGuests: 220,
        startTime: '18:00', endTime: '21:00', detail: 'Winter term starts; students back in town',
      },
    }],
  };
  serveAbout(chat);
  await renderApp('/locations/l1/agent?panel=questions', fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: chat }));
  const side = screen.getByTestId('agent-side');
  expect(await within(side).findByRole('heading', { name: 'More guests than usual on Jan 8 to Jan 10, 2027?' })).toBeTruthy();
  expect(within(side).getByText('About 220 guests. 6 pm to 9 pm.')).toBeTruthy();
  expect(within(side).getByText('Winter term starts; students back in town')).toBeTruthy();
});
