import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { COMPOSER_LABEL } from '../../src/chat/ui/Composer';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, PROPOSAL, PROPOSAL_ID, SALES_STEP, type FakeChatApi, type LiveTurn } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { aboutDraft } from '../../src/chat/about';
import { localToday } from '../../src/portal/locations/dates';
import { serveAbout } from './about-fakes';

// P25 TownwiseAI on web (spec 16.3): the keyboard (Enter sends, Shift+Enter and an input method's Enter don't),
// the conversations list's Escape, reduced motion, the polite live region, links that open in a new tab, and
// view-as's aria-disabled controls with the one read-only line.

class ResizeObserverPolyfill {
  observe(): void { return undefined; }
  unobserve(): void { return undefined; }
  disconnect(): void { return undefined; }
}
if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

let width = 1280;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => width });

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
  width = 1280;
  act(() => { window.dispatchEvent(new Event('resize')); });
});

const EMAIL = ['a', 'example.com'].join('@');

function renderAt(path: string, api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): void {
  // F10: GET .../estimates/about, with no forecast unless the test served another answer.
  if (!('about' in api)) serveAbout(api);
  const portal = fakePortalApi({ me, org: orgOf('member'), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: portal });
  window.history.replaceState(null, '', path);
  render(
    <Head.Provider>
      <ExpoRoot
        context={getMockContext(appRoutes(seededRoot(auth), {
          '(marketing)/index': () => null,
          '(gate)/sign-in': () => null,
          '(gate)/totp': () => null,
          '(gate)/auth/magic': () => null,
        }))}
        location={path}
      />
    </Head.Provider>,
  );
}

function turn(api: FakeChatApi): LiveTurn {
  const live = api.turns.at(-1);
  if (live === undefined) throw new Error('no turn');
  return live;
}

/** Events and the turn settling (a few promise hops after end) inside one act. */
async function stream(steps: () => void): Promise<void> {
  await act(() => new Promise((resolve) => {
    steps();
    setTimeout(resolve, 50);
  }));
}

function reduceMotion(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      matches: query === '(prefers-reduced-motion: reduce)' && reduce,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

test('the dashboard links to a location, whose TownwiseAI page streams a reply with a card, and saves its note', async () => {
  const api = fakeChatApi();
  renderAt('/dashboard', api);
  fireEvent.click(await screen.findByText('Main Street Bar'));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1'); });
  fireEvent.click(await screen.findByRole('link', { name: 'TownwiseAI' }));
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/agent'); });
  expect(await screen.findByText('Main Street Bar, Hanover, NH')).toBeTruthy();
  expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['TownwiseAI']);
  expect(screen.getByRole('log', { name: 'Conversation with TownwiseAI' })).toBeTruthy();

  fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'Closed for the holidays' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  await stream(() => {
    turn(api).emit('conversation', { id: 'c2', title: 'Closed for the holidays' });
    turn(api).emit('text', { delta: 'Here is a note.' });
    turn(api).emit('proposal', { id: PROPOSAL_ID, proposal: PROPOSAL });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  expect(screen.getByText('Here is a note.')).toBeTruthy();
  expect(screen.getByText('December 24, 2026 to December 26, 2026')).toBeTruthy();
  expect(screen.getByText('Based on this conversation only.')).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Save note' });
  fireEvent.click(save);
  const saved = await screen.findByText('Saved to Notes.');
  // The pressed button is gone: focus moves to the line that says what happened.
  await waitFor(() => { expect(document.activeElement?.contains(saved)).toBe(true); });
  expect(screen.getByRole('link', { name: 'Open Notes' }).getAttribute('href')).toBe('/locations/l1/notes');
});

test('the old chat address opens TownwiseAI, so links and bookmarks keep working', async () => {
  renderAt('/locations/l1/chat', fakeChatApi());
  await waitFor(() => { expect(window.location.pathname).toBe('/locations/l1/agent'); });
  expect(await screen.findByRole('heading', { level: 1, name: 'TownwiseAI' })).toBeTruthy();
  expect(await screen.findByLabelText(COMPOSER_LABEL)).toBeTruthy();
});

describe('the composer', () => {
  test('Enter sends; Shift+Enter is a new line; Enter while an input method composes does nothing', async () => {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    const input = await screen.findByLabelText(COMPOSER_LABEL);
    expect(input.getAttribute('aria-describedby')).toBe('composer-help');
    expect(document.getElementById('composer-help')?.textContent).toBe('Leave out guest names. TownwiseAI answers from your sales, your notes, Hanover’s town profile, the town calendar, who’s likely in Hanover and what your team added on Your data.');
    fireEvent.change(input, { target: { value: 'Closed Monday' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(api.turns).toHaveLength(0);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    expect(turn(api).body).toEqual({ content: 'Closed Monday' });
  });

  test('a counter shows from 3,600 characters, and the field takes at most 4,000', async () => {
    renderAt('/locations/l1/agent', fakeChatApi());
    const input = await screen.findByLabelText(COMPOSER_LABEL);
    expect(input.getAttribute('maxlength')).toBe('4000');
    fireEvent.change(input, { target: { value: 'x'.repeat(3599) } });
    expect(screen.queryByText(/of 4,000$/)).toBeNull();
    fireEvent.change(input, { target: { value: 'x'.repeat(3712) } });
    expect(screen.getByText('3,712 of 4,000')).toBeTruthy();
  });
});

test('the conversations list closes on Escape and gives focus back to its button', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  const button = await screen.findByRole('button', { name: 'Conversations' });
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const list = screen.getByRole('region', { name: 'Conversations' });
  expect(within(list).getByRole('button', { name: 'Earlier chat, Nov 2, 2026' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: 'Conversations' })).toBeNull();
  expect(document.activeElement).toBe(button);
});

test('F7: ?about= fills the composer with the day, sends nothing, and keeps the address', async () => {
  const api = fakeChatApi();
  const date = localToday();
  renderAt(`/locations/l1/agent?about=${date}`, api);
  const input = await screen.findByLabelText(COMPOSER_LABEL);
  await waitFor(() => { expect((input as HTMLTextAreaElement).value).toBe(aboutDraft(date, date)); });
  expect(api.turns).toHaveLength(0);
  expect(window.location.pathname).toBe('/locations/l1/agent');
  // The person sends it with Enter, as anything they typed.
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  expect(turn(api).body).toEqual({ content: aboutDraft(date, date) });
});

test('F7: a malformed ?about= leaves the composer empty', async () => {
  renderAt('/locations/l1/agent?about=2026-13-01', fakeChatApi());
  const input = await screen.findByLabelText(COMPOSER_LABEL);
  expect((input as HTMLTextAreaElement).value).toBe('');
});

test('F10: How Townwise estimates opens the model card as a dialog; Escape closes it', async () => {
  renderAt('/locations/l1/agent', fakeChatApi());
  const side = await screen.findByTestId('agent-side');
  fireEvent.click(within(side).getByRole('button', { name: 'How TownwiseAI works' }));
  fireEvent.click(within(side).getByRole('button', { name: 'How Townwise estimates' }));
  const dialog = await screen.findByRole('dialog', { name: 'How Townwise estimates' });
  expect(await within(dialog).findByText('Townwise has no forecast for Main Street Bar yet. Home and TownwiseAI use your history and Hanover’s calendar until it does.')).toBeTruthy();
  // react-native-web's Modal closes on Escape's keyup.
  fireEvent.keyUp(document, { key: 'Escape' });
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'How Townwise estimates' })).toBeNull(); });
});

describe('a tool card', () => {
  async function running(api: FakeChatApi): Promise<HTMLElement> {
    renderAt('/locations/l1/agent', api);
    fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'How was December?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => { turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'running', input: SALES_STEP.input, result: null }); });
    return screen.getByText('your sales for Dec 1 to Dec 31, 2025');
  }

  function faded(element: HTMLElement): boolean {
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      if (node.style.opacity !== '') return true;
    }
    return false;
  }

  test('fades in as it starts', async () => {
    reduceMotion(false);
    expect(faded(await running(fakeChatApi()))).toBe(true);
  });

  test('under reduced motion appears at once, with nothing animated', async () => {
    reduceMotion(true);
    expect(faded(await running(fakeChatApi()))).toBe(false);
  });

  test('the live region says each thing TownwiseAI starts reading, then that it replied, never the streamed text', async () => {
    const api = fakeChatApi();
    await running(api);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Reading your sales for Dec 1 to Dec 31, 2025');
    await stream(() => {
      turn(api).emit('tool', { id: SALES_STEP.id, name: SALES_STEP.name, state: 'done', input: SALES_STEP.input, result: SALES_STEP.result });
      turn(api).emit('text', { delta: 'December was steady.' });
    });
    expect(live?.textContent).toBe('TownwiseAI is replying');
    await stream(() => {
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(live?.textContent).toBe('TownwiseAI replied');
  });

  test('opening an earlier conversation announces nothing: only a reply to this visit’s message is news', async () => {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    fireEvent.click(await screen.findByRole('button', { name: 'Conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    await screen.findByText('Last December you were open every day.');
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('');
    fireEvent.change(screen.getByLabelText(COMPOSER_LABEL), { target: { value: 'And January?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('text', { delta: 'January was quiet.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    expect(live?.textContent).toBe('TownwiseAI replied');
    // Opening it again replays the reply, which is not news.
    fireEvent.click(screen.getByRole('button', { name: 'Conversations' }));
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    await waitFor(() => { expect(live?.textContent).toBe(''); });
  });
});

test('a town profile card’s sources open in a new tab', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api);
  fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'What drives Hanover?' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => { expect(api.turns).toHaveLength(1); });
  const result = { available: true, town: { name: 'Hanover', state: 'NH' }, sources: [{ host: 'dartmouth.edu', url: 'https://dartmouth.edu/calendar' }] };
  await stream(() => {
    turn(api).emit('tool', { id: 'toolu_test_0003', name: 'get_town_profile', state: 'done', input: null, result });
    turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
    turn(api).end();
  });
  expect(screen.getByText('Based on Hanover’s town profile (dartmouth.edu).')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show' }));
  fireEvent.click(screen.getByRole('button', { name: 'Read Hanover’s town profile. dartmouth.edu' }));
  const link = screen.getByRole('link', { name: 'dartmouth.edu' });
  expect(link.getAttribute('href')).toBe('https://dartmouth.edu/calendar');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
});

test('view-as: every write control is aria-disabled and described by the one read-only line', async () => {
  const api = fakeChatApi();
  renderAt('/locations/l1/agent', api, viewAsMe(ACCESS.member));
  await waitFor(() => { expect(document.getElementById('chat-ro')).toBeTruthy(); });
  const input = await screen.findByLabelText(COMPOSER_LABEL);
  expect(input.getAttribute('aria-readonly')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toBe('chat-ro composer-help');
  const answer = await screen.findByRole('button', { name: 'Yes, closed Mondays' });
  for (const control of [screen.getByRole('button', { name: 'Send' }), screen.getByRole('button', { name: 'New chat' }), answer]) {
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(control.getAttribute('aria-describedby')?.split(' ')).toContain('chat-ro');
    fireEvent.click(control);
  }
  expect(api.turns).toHaveLength(0);
  expect(api.writes).toHaveLength(0);
  expect(screen.getAllByText(/^Read-only while viewing as/)).toHaveLength(1);
});

test('nothing goes to browser storage', async () => {
  const setItem = jest.spyOn(Storage.prototype, 'setItem');
  try {
    const api = fakeChatApi();
    renderAt('/locations/l1/agent', api);
    fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => { expect(api.turns).toHaveLength(1); });
    await stream(() => {
      turn(api).emit('text', { delta: 'Hi.' });
      turn(api).emit('done', { stopReason: 'end_turn', costUsd: 0 });
      turn(api).end();
    });
    const [notSure] = await screen.findAllByRole('button', { name: 'Not sure' });
    if (notSure === undefined) throw new Error('no answer');
    fireEvent.click(notSure);
    await screen.findByText('Got it. TownwiseAI won’t ask about these days again.');
    expect(setItem).not.toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
});
