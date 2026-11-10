import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { appRoutes, seededRoot } from '../../helpers/app';
import { fakeAuth } from '../../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, openAsAdminMe, orgOf, viewAsMe, writes, type FakePortalApi } from '../../helpers/portal';
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

test('open as admin: no Leave section; the rest is the admin’s settings', async () => {
  const api = fakePortalApi({ me: openAsAdminMe(), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [ADD_EVENT] }) } });
  renderAt('/settings', api);
  expect(await screen.findByRole('region', { name: 'Townwise staff activity on Test Group' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: 'Townwise staff activity' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Leave Test Group' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Save name' }).getAttribute('aria-disabled')).not.toBe('true');
  expect(screen.getByRole('button', { name: 'Sign out on every device' }).getAttribute('aria-disabled')).not.toBe('true');
});

test('open as admin: Save name names the organization the page shows, so a stale tab’s rename never lands in another one', async () => {
  const api = fakePortalApi({ me: openAsAdminMe(), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [ADD_EVENT] }) } });
  api.answers['/api/org'] = () => ({ org: { id: 'o1', name: 'Harbor Group' } });
  renderAt('/settings', api);
  const field = await screen.findByRole('textbox', { name: 'Name' });
  fireEvent.change(field, { target: { value: 'Harbor Group' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByText('Saved.')).toBeTruthy();
  expect(writes(api)).toEqual([{ method: 'PATCH', path: '/api/org', body: { name: 'Harbor Group', orgId: 'o1' } }]);
});

test('staff activity pages: Show older staff activity adds the next 50 below, and goes once there are no more', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
  const at = ADD_EVENT.at;
  const older = { ...ADD_EVENT, at: '2026-10-01T15:00:00.000Z', summary: 'Renamed the organization from A to B' };
  withRoutes(api, {
    gets: {
      '/api/org/staff-activity': () => ({ events: [ADD_EVENT], nextBefore: at }),
      [`/api/org/staff-activity?before=${encodeURIComponent(at)}`]: () => ({ events: [older], nextBefore: null }),
    },
  });
  renderAt('/settings', api);
  const table = await screen.findByRole('region', { name: 'Townwise staff activity on Test Group' });
  expect(table.textContent).toContain(ADD_EVENT.summary);
  expect(table.textContent).not.toContain(older.summary);
  fireEvent.click(screen.getByRole('button', { name: 'Show older staff activity' }));
  expect(await screen.findByText(older.summary)).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Townwise staff activity on Test Group' }).textContent).toContain(ADD_EVENT.summary);
  expect(screen.queryByRole('button', { name: 'Show older staff activity' })).toBeNull();
});

test('D25: the staff activity intro names open as admin, so it never says staff read figures only through View as', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [ADD_EVENT] }) } });
  renderAt('/settings', api);
  expect(await screen.findByText(
    'Each time Townwise staff use View as to see your sales and notes, it’s recorded here with its reason. Before anyone from '
    + 'your organization joined, staff setting it up may have opened it as its admin, which shows them what an admin sees; '
    + 'each time is listed here, with every change they made. Otherwise staff can see your team’s email addresses, your '
    + 'location names and towns, and which dates your data covers. Any change staff make to your team, name or status is '
    + 'listed here too.',
  )).toBeTruthy();
});
