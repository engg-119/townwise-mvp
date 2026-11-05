import { act, cleanup, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import type { MeResponse } from '../../src/portal/schemas';
import { VIEW_AS_LINE_ID } from '../../src/portal/shell/ViewAsBanner';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';

// The client app's frame on phones, on web (spec 15.2, 15.5, 15.7): the top bar at 320px, the view-as banner's two
// rows, and the tuning chat, which needs the screen for the conversation.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

let width = 320;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

afterEach(() => {
  cleanup();
  width = 320;
  act(() => { window.dispatchEvent(new Event('resize')); });
});

function renderAt(path: string, me: MeResponse): void {
  const portal = fakePortalApi({ me, org: orgOf('member'), fallback: fakeChatApi() });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: portal });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot context={getMockContext(appRoutes(seededRoot(auth), { '(marketing)/index': () => null }))} location={path} />
    </Head.Provider>,
  );
}

function style(element: Element): CSSStyleDeclaration {
  return window.getComputedStyle(element);
}

function parentOf(element: HTMLElement): HTMLElement {
  if (element.parentElement === null) throw new Error('no parent');
  return element.parentElement;
}

describe.each([
  ['a member', meOf(ACCESS.member)],
  ['staff viewing as a member', viewAsMe(ACCESS.member)],
])('at 320px, for %s', (_who, me) => {
  test('Sign out holds its width and the organization name takes the squeeze with an ellipsis', async () => {
    renderAt('/locations/l1/notes', me);
    await screen.findByRole('heading', { level: 1, name: 'Main Street Bar' });
    const signOut = within(screen.getByRole('banner')).getByRole('button', { name: 'Sign out' });
    // The box around Sign out never shrinks, so Sign out can't pass the 16px margin or wrap to “Sign / out”.
    expect(style(parentOf(signOut)).flexShrink).toBe('0');
    const org = within(screen.getByRole('banner')).getByText('Test Group');
    expect(style(org).whiteSpace).toBe('nowrap');
    expect(style(org).textOverflow).toBe('ellipsis');
    expect(style(org).flexShrink).toBe('1');
  });
});

test('at 320px the view-as banner is two rows: its words as one paragraph, then End view-as', async () => {
  renderAt('/dashboard', viewAsMe(ACCESS.member));
  const banner = await screen.findByRole('region', { name: 'View-as' });
  const until = within(banner).getByText(/^Read-only until \d{1,2}:\d{2} (AM|PM)\.$/);
  const who = within(banner).getByText('gm@example.org, Member at Test Group.');
  // One paragraph that wraps as a whole, rather than three blocks with gaps between them.
  expect(until.tagName).toBe('SPAN');
  expect(who.tagName).toBe('SPAN');
  const paragraph = parentOf(until);
  expect(who.parentElement).toBe(paragraph);
  expect(paragraph.textContent).toMatch(/^Viewing as {2}gm@example\.org, Member at Test Group\. {2}Read-only until/);
  // Sign out is still described by the read-only line.
  expect(document.getElementById(VIEW_AS_LINE_ID)).toBe(until);
  const end = within(banner).getByRole('button', { name: 'End view-as' });
  const rows = parentOf(paragraph);
  expect([...rows.children]).toEqual([paragraph, end]);
  expect(style(rows).paddingTop).toBe('8px');
  expect(style(rows).paddingBottom).toBe('8px');
  expect(style(end).alignSelf).toBe('stretch');
});

describe.each([
  ['a member', meOf(ACCESS.member)],
  ['staff viewing as a member', viewAsMe(ACCESS.member)],
])('the chat at 320px, for %s', (_who, me) => {
  test('a compact header (the name on one line, no eyebrow or switcher) and the tabs scroll with the thread; the composer stays below', async () => {
    renderAt('/locations/l1/chat', me);
    // While the chat loads, the header sits above the loading line; then it moves into the thread.
    const thread = await screen.findByTestId('chat-thread');
    const title = screen.getByRole('heading', { level: 1, name: 'Main Street Bar' });
    expect(screen.getAllByRole('heading', { name: 'Main Street Bar' })).toEqual([title]);
    expect(style(title).whiteSpace).toBe('nowrap');
    expect(style(title).textOverflow).toBe('ellipsis');
    expect(screen.queryByRole('combobox', { name: 'Location' })).toBeNull();
    expect(screen.queryByText('Hanover, NH')).toBeNull();
    expect(thread.contains(title)).toBe(true);
    expect(within(thread).getByRole('region', { name: 'Location sections' })).toBeTruthy();
    const composer = screen.getByLabelText('Message');
    expect(thread.contains(composer)).toBe(false);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});
