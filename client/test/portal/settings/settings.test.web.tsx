import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
import { ADD_EVENT, withRoutes } from '../team/fixtures';

// Settings on web: the two-step link is a real link, Sign out on every device is described by its help line,
// and under view-as every write is aria-disabled and described by the page's one read-only line (spec 15.5, 15.7).

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

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

const EVERYWHERE = `Sign out on every device ends every Townwise sign-in for ${EMAIL} right away, this one included.`;

test('a member: the two-step link, and Sign out on every device described by its help line', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  withRoutes(api);
  renderAt('/settings', api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Two-step sign-in settings' }).getAttribute('href')).toBe('/settings/security');
  expect(describedText(screen.getByRole('button', { name: 'Sign out on every device' }))).toEqual([EVERYWHERE]);
});

test('view-as of an org admin: every write aria-disabled, focusable, and described by the read-only line', async () => {
  const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [ADD_EVENT] }) } });
  renderAt('/settings', api);
  expect(await screen.findByRole('region', { name: 'Townwise staff activity on Test Group' })).toBeTruthy();
  const line = 'Read-only while viewing as gm@example.org.';
  expect(document.getElementById('settings-ro')?.textContent).toBe(line);
  expect(screen.getByRole('textbox', { name: 'Name' }).getAttribute('aria-readonly')).toBe('true');
  for (const name of ['Save name', 'Two-step sign-in settings', 'Leave Test Group']) {
    const control = screen.getByRole('button', { name });
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.hasAttribute('disabled')).toBe(false);
    expect(describedText(control)).toEqual([line]);
    fireEvent.click(control);
  }
  const everywhere = screen.getByRole('button', { name: 'Sign out on every device' });
  expect(everywhere.getAttribute('aria-disabled')).toBe('true');
  expect(describedText(everywhere)).toEqual([`Sign out on every device ends every Townwise sign-in for gm@example.org right away, this one included.`, line]);
  expect(screen.queryByRole('link', { name: 'Two-step sign-in settings' })).toBeNull();
  expect(writes(api)).toEqual([]);
});
