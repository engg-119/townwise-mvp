import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import type { MeResponse } from '../../src/portal/schemas';
import { VIEW_AS_LINE_ID } from '../../src/portal/shell/ViewAsBanner';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, EMAIL, fakePortalApi, INVITE, meOf, orgOf, SECOND_INVITE, viewAsMe } from '../helpers/portal';

// The client app's frame on phones, on web (spec 15.2, 15.5, 15.7): the top bar at 320px, the view-as banner's two
// rows, and TownwiseAI, which needs the screen for the conversation.

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
  // TownwiseAI keeps the conversation it closed on in localStorage (src/chat/lastChat.ts): each test opens a new page.
  localStorage.clear();
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
  test('Menu holds its width and the organization name takes the squeeze with an ellipsis', async () => {
    renderAt('/locations/l1/notes', me);
    await screen.findByRole('heading', { level: 1, name: 'Notes' });
    const menu = within(screen.getByRole('banner')).getByRole('button', { name: 'Menu' });
    // The box around the switch and Menu never shrinks, so Menu can't pass the 16px margin.
    expect(style(parentOf(menu)).flexShrink).toBe('0');
    // A link in the menu opens its page, closes the menu and hands focus to Menu, as the link is about to leave.
    fireEvent.click(menu);
    fireEvent.click(within(within(screen.getByRole('banner')).getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Town' }));
    await screen.findByRole('heading', { level: 1, name: 'Town' });
    const after = within(screen.getByRole('banner')).getByRole('button', { name: 'Menu' });
    expect(after.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(after);
    // A press on the current page's link, which moves nowhere, closes it too.
    fireEvent.click(after);
    expect(after.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(within(screen.getByRole('banner')).getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Town' }));
    expect(after.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { level: 1, name: 'Town' })).toBeTruthy();
    const org = within(screen.getByRole('banner')).getByText('Test Group');
    expect(style(org).whiteSpace).toBe('nowrap');
    expect(style(org).textOverflow).toBe('ellipsis');
    expect(style(org).flexShrink).toBe('1');
  });
});

test.each([
  ['rejected', ACCESS.rejected],
  ['paused', ACCESS.suspended],
] as const)('at 320px on No access, %s, the contact address and Sign out in their sentences are 44px tap targets', async (_variant, access) => {
  renderAt('/no-access', meOf(access));
  const links = [
    await screen.findByRole('link', { name: 'hello@townwise.tech' }),
    screen.getByRole('link', { name: 'Sign out' }),
  ];
  for (const link of links) {
    // 18 to 20px of text and 13px above and below, inline, so the sentence keeps its lines.
    expect(style(link).paddingTop).toBe('13px');
    expect(style(link).paddingBottom).toBe('13px');
    expect(style(link).display).toBe('inline');
  }
});

test('at 320px Choose your team sets the count of organizations as a mono numeral in its sentence', async () => {
  renderAt('/joining', meOf({ state: 'invited', invitations: [INVITE, SECOND_INVITE], pendingRequest: null }));
  await screen.findByRole('heading', { level: 1, name: 'Choose your team' });
  const count = screen.getByText('2', { selector: 'span' });
  expect(count.parentElement?.textContent).toMatch(/^2 organizations added /);
  expect(style(count).fontFamily).toContain('Geist Mono');
  expect(style(parentOf(count)).fontFamily).not.toContain('Geist Mono');
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
])('TownwiseAI at 320px, for %s', (_who, me) => {
  test('there is no page header, so nothing scrolls above the chat header; the sections are in the top bar’s menu; the composer docks under the thread', async () => {
    renderAt('/locations/l1/agent', me);
    const landing = await screen.findByTestId('chat-landing');
    const title = screen.getByRole('heading', { level: 1, name: 'TownwiseAI' });
    expect(screen.getAllByRole('heading', { level: 1 })).toEqual([title]);
    expect(screen.queryByText(/^Welcome back/)).toBeNull();
    expect(screen.queryByText('Main Street Bar, Hanover, NH')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Location' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'All locations' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Location settings' })).toBeNull();
    // The chat header is outside what scrolls, so it is the first thing under the top bar.
    const history = screen.getByRole('button', { name: 'History' });
    expect(landing.contains(history)).toBe(false);
    const banner = screen.getByRole('banner');
    expect(landing.contains(banner)).toBe(false);
    fireEvent.click(within(banner).getByRole('button', { name: 'Menu' }));
    expect(within(within(banner).getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'TownwiseAI' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(banner).getByRole('button', { name: 'Menu' }));
    expect(landing.contains(screen.getByLabelText(COMPOSER_LABEL))).toBe(true);
    // With messages, the header stays above the thread and the composer stays below it.
    fireEvent.click(history);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    const thread = await screen.findByTestId('chat-thread');
    await within(thread).findByText('We close for the holidays.');
    expect(thread.contains(screen.getByRole('button', { name: 'History' }))).toBe(false);
    expect(thread.contains(screen.getByRole('banner'))).toBe(false);
    expect(thread.contains(screen.getByLabelText(COMPOSER_LABEL))).toBe(false);
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  test('the composer is one rounded row: the input, named by its label with no label drawn, at one line, and Send beside it', async () => {
    renderAt('/locations/l1/agent', me);
    await screen.findByTestId('chat-landing');
    const input = screen.getByLabelText(COMPOSER_LABEL);
    expect(screen.queryByText(COMPOSER_LABEL)).toBeNull();
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.getAttribute('rows')).toBe('1');
    expect(style(input).minHeight).toBe('44px');
    expect(input.getAttribute('placeholder')).toBe('Ask TownwiseAI');
    const send = screen.getByRole('button', { name: 'Send' });
    const box = parentOf(parentOf(input));
    expect(box.contains(send)).toBe(true);
    expect(style(box).flexDirection).toBe('row');
    expect(style(box).borderTopLeftRadius).toBe('28px');
  });
});

test('at 320px the composer grows with its text, up to its maximum, and starts over when emptied', async () => {
  // jsdom lays nothing out: a textarea's content is 24px a line plus its 20px of padding.
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) { return this.value.split('\n').length * 24 + 20; },
  });
  try {
    renderAt('/locations/l1/agent', meOf(ACCESS.member));
    await screen.findByTestId('chat-landing');
    // The input has no border of its own: the rounded box around it draws the edge.
    const input = screen.getByLabelText<HTMLTextAreaElement>(COMPOSER_LABEL);
    expect(input.style.height).toBe('44px');
    fireEvent.change(input, { target: { value: 'Closed\nfor the\nholidays' } });
    expect(input.style.height).toBe('92px');
    expect(style(input).maxHeight).toBe('200px');
    fireEvent.change(input, { target: { value: '' } });
    expect(input.style.height).toBe('44px');
  } finally {
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight');
    if (scrollHeight !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
  }
});
