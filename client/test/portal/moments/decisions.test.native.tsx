jest.mock('@react-native-google-signin/google-signin', () => {
  const mocked: unknown = jest.requireActual('../../helpers/googleSigninMock');
  return mocked;
});
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { act, cleanup, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { AccessibilityInfo, Pressable, Text } from 'react-native';

import { useMoment } from '../../../src/portal/moments';
import { usePortal } from '../../../src/portal/PortalProvider';
import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, deferred, EMAIL, fakePortalApi, meOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { renderApp } from '../../helpers/renderApp';

// Which moment plays when, with MomentProvider mounted by PortalGate over the whole app (spec 15.8): request received
// on the send's pending answer, the welcome while GET /api/me carries it, and nothing on a fresh load or under view-as.

const ALL = { includeHiddenElements: true };
const WELCOME = { firstName: 'Pat', restaurant: 'Sample Mountain Tavern' };
const SENT = 'We’ve received your request for Sample Mountain Tavern. We’ll let you in soon.';
const WELCOMED = 'Welcome to Townwise, Pat. Sample Mountain Tavern, ready to set up.';

function layer() {
  return screen.queryByTestId('statement-layer', ALL);
}

function system() {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
  return { announce: jest.spyOn(AccessibilityInfo, 'announceForAccessibility') };
}

/** What useMoment().playing was in each render of the member's first page, in order. */
let playingSeen: boolean[] = [];

function Probe(): React.JSX.Element {
  const { playing } = useMoment();
  playingSeen.push(playing);
  return <Text>Probe page</Text>;
}

/** The app at /dashboard with the member's first page replaced by `page`. */
async function renderMemberApp(api: FakePortalApi, page: React.ComponentType = Probe) {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  return renderRouter(appRoutes(seededRoot(auth), { '(gate)/(app)/(client)/dashboard': page }), { initialUrl: '/dashboard' });
}

function welcomePosts(api: FakePortalApi) {
  return writes(api).filter((call) => call.path === '/api/me/welcome');
}

/** Moves renderRouter's fake clock on by `ms`, letting answers and effects settle on the way. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 50) {
    await act(async () => { jest.advanceTimersByTime(Math.min(50, left)); await Promise.resolve(); });
  }
}

/** Lets the first GET /api/me answer and the first page render, without moving the clock past a moment's start. */
async function load(): Promise<void> {
  await advance(50);
  expect(screen.getByText('Probe page')).toBeTruthy();
}

/** The moment's whole timeline and then some. */
async function outlast(): Promise<void> {
  await advance(3600);
}

beforeEach(() => {
  jest.clearAllMocks();
  playingSeen = [];
});

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
});

test('the send’s pending answer covers the redirect with the request-received statement, then hands off to Waiting', async () => {
  const { announce } = system();
  const api = fakePortalApi({ me: meOf(ACCESS.noOrg) });
  const answer = deferred<unknown>();
  api.answers['/api/access-requests'] = () => answer.promise;
  const { router } = await renderApp('/request-access', api);
  await fireEvent.changeText(await screen.findByLabelText('Organization name'), 'Sample Mountain Tavern');
  await fireEvent.changeText(screen.getByLabelText('Your name'), 'Pat');
  await fireEvent.changeText(screen.getByLabelText('Your role'), 'Owner');
  await fireEvent.press(screen.getByLabelText('Town'));
  await fireEvent.press(screen.getByRole('radio', { name: 'Stowe, VT' }));
  await fireEvent.changeText(screen.getByLabelText('Number of locations'), '3');
  await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
  expect(layer()).toBeNull();
  await act(async () => { answer.resolve(meOf(ACCESS.pending)); await answer.promise; });
  await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
  expect(layer()).not.toBeNull();
  for (const word of ['Sample', 'Tavern.', 'soon.']) expect(screen.getByText(word, ALL)).toBeTruthy();
  await waitFor(() => { expect(announce.mock.calls).toEqual([[SENT]]); });
  await outlast();
  expect(layer()).toBeNull();
  expect(router.getPathname()).toBe('/waiting');
  expect(announce).toHaveBeenCalledTimes(1);
  // Nothing is recorded for this moment: the request is the only write besides P3's one check whether the Google
  // Places search is on (onboarding/places.ts).
  expect(writes(api).map((call) => call.path).filter((path) => path !== '/api/places/autocomplete'))
    .toEqual(['/api/access-requests']);
});

test('a fresh load of /waiting plays nothing', async () => {
  const { announce } = system();
  const api = fakePortalApi({ me: meOf(ACCESS.pending) });
  const { router } = await renderApp('/waiting', api);
  await waitFor(() => { expect(router.getPathname()).toBe('/waiting'); });
  await act(async () => { await Promise.resolve(); });
  expect(layer()).toBeNull();
  expect(announce).not.toHaveBeenCalled();
});

test('the welcome is up in the first commit and useMoment().playing is true there', async () => {
  system();
  const api = fakePortalApi({ me: meOf(ACCESS.admin, { welcome: WELCOME }) });
  await renderMemberApp(api);
  await load();
  expect(playingSeen[0]).toBe(true);
  expect(playingSeen).not.toContain(false);
  expect(layer()).not.toBeNull();
  for (const word of ['Welcome', 'Pat.', 'Tavern,', 'up.']) expect(screen.getByText(word, ALL)).toBeTruthy();
});

test('the welcome posts /api/me/welcome once, at start, and a refreshMe does not replay it', async () => {
  const { announce } = system();
  // The POST answers 404 here (the fake has no answer for it), so GET /api/me keeps carrying the welcome.
  const api = fakePortalApi({ me: meOf(ACCESS.admin, { welcome: WELCOME }) });
  function Refresher(): React.JSX.Element {
    const { playing } = useMoment();
    playingSeen.push(playing);
    const { refreshMe } = usePortal();
    return (
      <Pressable role="button" onPress={() => { refreshMe().catch(() => undefined); }}>
        <Text>Probe page</Text>
      </Pressable>
    );
  }
  await renderMemberApp(api, Refresher);
  await load();
  await waitFor(() => { expect(welcomePosts(api)).toEqual([{ method: 'POST', path: '/api/me/welcome', body: undefined }]); });
  expect(announce.mock.calls).toEqual([[WELCOMED]]);
  await outlast();
  expect(layer()).toBeNull();
  const before = playingSeen.length;
  const reads = api.calls.filter((call) => call.path === '/api/me').length;
  await fireEvent.press(screen.getByRole('button', { name: 'Probe page' }));
  await advance(50);
  expect(api.calls.filter((call) => call.path === '/api/me')).toHaveLength(reads + 1);
  expect(layer()).toBeNull();
  expect(playingSeen.slice(before)).not.toContain(true);
  expect(welcomePosts(api)).toHaveLength(1);
  expect(announce).toHaveBeenCalledTimes(1);
});

test('under view-as nothing plays and nothing is posted, even with a welcome in the answer', async () => {
  const { announce } = system();
  const api = fakePortalApi({ me: { ...viewAsMe(ACCESS.admin), welcome: WELCOME } });
  await renderMemberApp(api);
  await load();
  await act(async () => { await Promise.resolve(); });
  expect(layer()).toBeNull();
  expect(playingSeen).not.toContain(true);
  expect(welcomePosts(api)).toEqual([]);
  expect(announce).not.toHaveBeenCalled();
});

test('a member with no welcome in the answer sees no moment', async () => {
  system();
  const api = fakePortalApi({ me: meOf(ACCESS.admin, { welcome: null }) });
  await renderMemberApp(api);
  await load();
  expect(layer()).toBeNull();
  expect(playingSeen).not.toContain(true);
  expect(welcomePosts(api)).toEqual([]);
});
