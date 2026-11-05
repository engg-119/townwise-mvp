jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve()),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

import { cleanup, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import MarketingLayout from '../../app/(marketing)/_layout';
import About from '../../app/(marketing)/about';
import Privacy from '../../app/(marketing)/privacy';
import Terms from '../../app/(marketing)/terms';
import PublicSecurity from '../../app/(marketing)/security';

afterEach(async () => {
  await cleanup();
});

const routes = {
  '(marketing)/_layout': MarketingLayout,
  '(marketing)/about': About,
  '(marketing)/privacy': Privacy,
  '(marketing)/terms': Terms,
  '(marketing)/security': PublicSecurity,
  'settings/security': () => null,
};

test.each([
  ['/about', 'We think a small town deserves its own forecast.', 'What we’re building'],
  ['/privacy', 'Privacy', 'Cookies'],
  ['/terms', 'Terms of use', '01 Who you are agreeing with'],
  ['/security', 'Security', 'How we think about it'],
])('%s renders as plain text with a Back button', async (path, title, heading) => {
  await renderRouter(routes, { initialUrl: path });
  expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  expect(screen.getByText('Back')).toBeTruthy();
  // In-page navigation is web only, and the web chrome is not here.
  expect(screen.queryByText('On this page')).toBeNull();
  expect(screen.queryByText('Skip to content')).toBeNull();
  expect(screen.queryByText('TOWNWISE')).toBeNull();
});

test('the copy comes through', async () => {
  await renderRouter(routes, { initialUrl: '/privacy' });
  expect(screen.getByText(/Two cookies keep you signed in\./)).toBeTruthy();
  expect(screen.getByText('__Host-refresh')).toBeTruthy();
  expect(screen.getByText(/The operator responsible for your data is the Townwise team/)).toBeTruthy();
  expect(screen.getByText(/Anthropic receives the messages you send and the location data the assistant reads/)).toBeTruthy();
  expect(screen.getByText('Commercial Terms of Service')).toBeTruthy();
});

// A placeholder is any bracketed text that starts with a capital ([DECISION NEEDED: …], [PRICE], [HOW: …]).
test.each(['/about', '/privacy', '/terms', '/security'])('%s renders no bracketed placeholder on native', async (path) => {
  await renderRouter(routes, { initialUrl: path });
  expect(screen.queryAllByText(/\[[A-Z][^\]]*\]/)).toEqual([]);
});

test('links between pages work on native', async () => {
  const router = await renderRouter(routes, { initialUrl: '/terms' });
  const [first] = screen.getAllByText('Privacy notice');
  if (first === undefined) throw new Error('no Privacy notice link');
  await fireEvent.press(first);
  expect(router.getPathname()).toBe('/privacy');
});

test('the public security page links to the two-factor settings', async () => {
  const router = await renderRouter(routes, { initialUrl: '/security' });
  await fireEvent.press(screen.getByText('Two-factor settings'));
  expect(router.getPathname()).toBe('/settings/security');
});
