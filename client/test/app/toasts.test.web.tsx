import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { LocationSummary } from '../../src/portal/schemas';
import { resetProfiles } from '../../src/portal/profile/useProfile';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, LOCATIONS, meOf, openAsAdminMe, orgOf, staffMe, viewAsMe, type FakePortalApi } from '../helpers/portal';
import { locationsFake, noteOf, salesOf } from '../portal/locations/fakes';
import { ADD_EVENT, withRoutes } from '../portal/team/fixtures';

// What an action did is a toast on every signed-in page, and no row in the page (spec 15.7, D55): one page per family
// of notice, in the whole app, where the toast host is mounted by the portal layout. Each checks that the words are in
// the toast region, outside <main>, and that the page holds no notice row.

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
  jest.restoreAllMocks();
  cleanup();
  resetProfiles();
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

function only(id: string): LocationSummary {
  const found = LOCATIONS.find((location) => location.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

/** The open confirm dialog: the last one, since a Modal's own box is a dialog too. */
function dialog(): HTMLElement {
  const found = screen.getAllByRole('dialog').at(-1);
  if (found === undefined) throw new Error('no dialog');
  return found;
}

/** The toasts on screen, top to bottom. */
function toasts(): string[] {
  return screen.queryAllByTestId('toast-text').map((line) => line.textContent);
}

/** The toast that says `text`: in the polite live region, outside the page's <main>, which has no notice row. */
async function expectToast(text: string | RegExp): Promise<void> {
  const line = await screen.findByText(text);
  const region = line.closest('[role="status"]');
  expect(region?.getAttribute('aria-live')).toBe('polite');
  expect(line.closest('[data-testid="toast"]')).not.toBeNull();
  const main = screen.getByRole('main');
  expect(main.contains(line)).toBe(false);
  expect(within(main).queryByText(text)).toBeNull();
  expect(document.activeElement === null || !region?.contains(document.activeElement)).toBe(true);
}

test('the toast region is in every signed-in page before any toast', async () => {
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member') });
  withRoutes(api);
  renderAt('/settings', api);
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  const regions = screen.getAllByRole('status').filter((region) => region.getAttribute('aria-live') === 'polite' && !screen.getByRole('main').contains(region));
  expect(regions).toHaveLength(1);
  expect(toasts()).toEqual([]);
});

test('Location settings: Save changes says Saved in a toast, and the page has no row for it', async () => {
  const fake = locationsFake({ sales: { l1: salesOf([]), l2: salesOf([]) } });
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake });
  const renamed = { ...only('l1'), name: 'Main Street Tavern' };
  api.answers['/api/org/locations/l1'] = () => {
    api.org = orgOf('org_admin', [renamed, only('l2')]);
    return { location: renamed };
  };
  renderAt('/locations/l1/settings', api);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Main Street Tavern' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await expectToast('Saved.');
  expect(toasts()).toEqual(['Saved.']);
  expect(window.location.pathname).toBe('/locations/l1/settings');
  // The organization read again and the page drew again: still one toast.
  expect(await screen.findByText('Main Street Tavern, Hanover, NH')).toBeTruthy();
  expect(toasts()).toEqual(['Saved.']);
});

test('Settings: Save name says Saved in a toast', async () => {
  const api = fakePortalApi({ me: openAsAdminMe(), org: orgOf('org_admin') });
  withRoutes(api, { gets: { '/api/org/staff-activity': () => ({ events: [ADD_EVENT] }) } });
  api.answers['/api/org'] = () => ({ org: { id: 'o1', name: 'Harbor Group' } });
  renderAt('/settings', api);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Harbor Group' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await expectToast('Saved.');
  expect(toasts()).toEqual(['Saved.']);
});

test('Notes: deleting a note says so in a toast, and deleting the next one says it again', async () => {
  const notes = [
    noteOf('n1', { kind: 'other', startDate: '2025-03-01', endDate: '2025-03-02', detail: 'Road work.' }),
    noteOf('n2', { kind: 'other', startDate: '2025-04-01', endDate: '2025-04-02', detail: 'A parade.' }),
  ];
  const fake = locationsFake({ notes: { l1: notes } });
  const api = fakePortalApi({ me: meOf(ACCESS.member), org: orgOf('member'), fallback: fake });
  renderAt('/locations/l1/notes', api);
  const past = await screen.findByRole('region', { name: 'Past notes' });
  const first = within(past).getAllByRole('button', { name: /^Delete Other note/ })[0];
  if (first === undefined) throw new Error('no Delete');
  fireEvent.click(first);
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete note' }));
  await expectToast('Deleted the note.');
  // The second delete has the same words: its toast is the one already up, said again, not a second copy.
  const said = screen.getByText('Deleted the note.');
  // Two seconds on: within one second the same words are taken for a double press and ignored.
  const now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now + 2000);
  fireEvent.click(within(screen.getByRole('region', { name: 'Past notes' })).getByRole('button', { name: /^Delete Other note/ }));
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Delete note' }));
  await waitFor(() => { expect(screen.queryByRole('region', { name: 'Past notes' })).toBeNull(); });
  await waitFor(() => { expect(screen.getByText('Deleted the note.')).not.toBe(said); });
  expect(toasts()).toEqual(['Deleted the note.']);
});

test('a notice that crosses pages is a toast on the page it lands on: deleting a location', async () => {
  const fake = locationsFake({ sales: { l1: salesOf([]), l2: salesOf([]) } });
  const api = fakePortalApi({ me: meOf(ACCESS.admin), org: orgOf('org_admin'), fallback: fake });
  fake.deletes['/api/org/locations/l1'] = () => {
    api.org = orgOf('org_admin', [only('l2')]);
    return null;
  };
  renderAt('/locations/l1/settings', api);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete location' }));
  const confirm = dialog();
  fireEvent.change(within(confirm).getByRole('textbox', { name: 'Type Main Street Bar to confirm.' }), { target: { value: 'Main Street Bar' } });
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete location' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l2'); });
  await expectToast('Deleted Main Street Bar.');
  expect(toasts()).toEqual(['Deleted Main Street Bar.']);
});

test('view-as ended: the console opens with the time in a toast', async () => {
  const api = fakePortalApi({ me: viewAsMe(ACCESS.admin), org: orgOf('org_admin') });
  api.answers['/api/admin/view-as/end'] = () => staffMe();
  renderAt('/dashboard', api);
  await screen.findByRole('region', { name: 'View-as' });
  fireEvent.click(screen.getByRole('button', { name: 'End view-as' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/admin'); });
  await expectToast(/^View-as ended at \d{1,2}:\d{2} (AM|PM)\.$/);
  expect(toasts()).toHaveLength(1);
});
