import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { TEAM, withRoutes } from './fixtures';
import { choose } from '../../helpers/select';

// Team on web: the labels, helpers and read-only line are tied by id, and disabled controls stay focusable
// (aria-disabled, never the disabled attribute), as spec 15.7 asks.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// jsdom's document is 0px wide, which is a phone to react-native-web; these tests cover the desktop layout.
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });

afterEach(() => {
  cleanup();
});

function renderAt(path: string, api: FakePortalApi): void {
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

function describedText(element: HTMLElement): string[] {
  return (element.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? `missing ${id}`);
}

test('the add form: labeled fields with their helpers, a real select, and the results as a status list', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/members': () => ({ members: TEAM }) } });
  api.answers['/api/org/members'] = () => ({ results: [{ email: 'cook@example.com', outcome: 'invited' }], members: TEAM });
  renderAt('/team', api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Team' })).toBeTruthy();
  const emails = screen.getByRole('textbox', { name: 'Email addresses' });
  expect(describedText(emails)).toEqual(['One per line or separated by commas, up to 20.']);
  const role = screen.getByRole('combobox', { name: 'Role' });
  expect(describedText(role)).toEqual(['Everyone you add at once gets this role. You can change it on any row below.']);
  expect(screen.getByRole('region', { name: 'Team members and invited addresses' })).toBeTruthy();
  fireEvent.change(emails, { target: { value: 'cook@example.com' } });
  choose(role, 'Admin');
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  const results = await screen.findByRole('status', { name: 'Results of adding addresses' });
  expect(within(results).getByText('Added. They can join the next time they continue with Google.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'POST', path: '/api/org/members', body: { emails: ['cook@example.com'], role: 'org_admin' } }]);
});

test('view-as: every write is aria-disabled, focusable, and described by the one read-only line', async () => {
  const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/members': () => ({ members: TEAM }) } });
  renderAt('/team', api);
  await screen.findByText('manager@example.com');
  expect(document.getElementById('team-ro')?.textContent).toBe('Read-only while viewing as gm@example.org.');
  for (const name of ['Add', 'Make admin, manager@example.com', 'Remove, manager@example.com', 'Remove invitation, chef@example.com']) {
    const control = screen.getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.hasAttribute('disabled')).toBe(false);
    expect(describedText(control)).toEqual(['Read-only while viewing as gm@example.org.']);
    fireEvent.click(control);
  }
  expect(screen.getByRole('textbox', { name: 'Email addresses' }).getAttribute('aria-readonly')).toBe('true');
  expect(screen.getByRole('combobox', { name: 'Role' }).getAttribute('aria-disabled')).toBe('true');
  expect(writes(api)).toEqual([]);
});
