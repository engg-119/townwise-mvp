import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import Head from 'expo-router/head';
import { getMockContext } from 'expo-router/testing-library';

import { resetDrafts } from '../../src/chat/drafts';
import { DROP_BLOCKED } from '../../src/chat/ui/AgentChat';
import { ChatDrop, DROP_KEPT, DROP_TITLE, WATCHDOG_MS } from '../../src/chat/ui/ChatDrop.web';
import type { MeResponse } from '../../src/portal/schemas';
import { appRoutes, seededRoot } from '../helpers/app';
import { fakeChatApi, type FakeChatApi } from '../helpers/chat';
import { fakeAuth } from '../helpers/fakes';
import { ACCESS, fakePortalApi, meOf, orgOf, viewAsMe } from '../helpers/portal';
import { filesFake } from '../portal/files/fakes';
import { serveAbout } from './about-fakes';

// The TownwiseAI page's drop overlay (spec P25, D36): only a drag of files shows it; it goes on the drop, when the
// drag leaves the window, on dragend, Escape, window blur and after WATCHDOG_MS with no dragover, so it can't stick;
// it takes no pointer events and no focus, is aria-hidden, and fades and scales in unless motion is reduced. When
// files can't be attached it says why, shows no drop, and a drop opens nothing. On the page, it is drawn outside the
// dock, so the dock and the thread's end padding never change, and dropped files become the composer's chips.

/** Every observer made, and what it watches, so a test can lay an element out as a browser would. */
const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
class ResizeObserverPolyfill {
  readonly callback: ResizeObserverCallback;
  readonly targets = new Set<Element>();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element): void { this.targets.add(target); }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); }
}
if (typeof globalThis.ResizeObserver !== 'function') globalThis.ResizeObserver = ResizeObserverPolyfill;

afterEach(() => {
  cleanup();
  resetDrafts();
  jest.useRealTimers();
  Reflect.deleteProperty(window, 'matchMedia');
});

interface DragInit { types?: string[]; files?: File[]; relatedTarget?: EventTarget | null; x?: number; y?: number }

/** A drag event as a browser sends it, with its dataTransfer; answers it, to read what the page did with it. */
function drag(type: string, init: DragInit = {}, target: EventTarget = document.body): MouseEvent & { dataTransfer: { dropEffect: string } } {
  const event = new MouseEvent(type, {
    bubbles: true, cancelable: true, relatedTarget: init.relatedTarget ?? null, clientX: init.x ?? 100, clientY: init.y ?? 100,
  }) as MouseEvent & { dataTransfer: { dropEffect: string } };
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: init.types ?? ['Files'], files: init.files ?? [], items: [], dropEffect: 'none' },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}

function overlay(): HTMLElement | null {
  return screen.queryByTestId('chat-drop');
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

describe('the overlay', () => {
  function mount(blocked: string | null = null): { onFiles: jest.Mock; onRefused: jest.Mock } {
    const onFiles = jest.fn();
    const onRefused = jest.fn();
    render(<ChatDrop blocked={blocked} onFiles={onFiles} onRefused={onRefused} />);
    return { onFiles, onRefused };
  }

  test('is absent while nothing is dragged, and a drag of anything but files never shows it', () => {
    mount();
    expect(overlay()).toBeNull();
    const text = drag('dragenter', { types: ['text/plain'] });
    expect(text.defaultPrevented).toBe(false);
    drag('dragover', { types: ['text/uri-list'] });
    expect(overlay()).toBeNull();
  });

  test('shows for a drag of files: fixed over the whole viewport, aria-hidden, taking no pointer events and no focus', () => {
    mount();
    const before = document.activeElement;
    expect(drag('dragenter').defaultPrevented).toBe(true);
    const shown = overlay();
    if (shown === null) throw new Error('no overlay');
    expect(shown.getAttribute('aria-hidden')).toBe('true');
    const style = getComputedStyle(shown);
    expect([style.position, style.top, style.right, style.bottom, style.left]).toEqual(['fixed', '0px', '0px', '0px', '0px']);
    expect(style.pointerEvents).toBe('none');
    expect(within(shown).getByText(DROP_TITLE)).toBeTruthy();
    expect(within(shown).getByText(DROP_KEPT)).toBeTruthy();
    const box = getComputedStyle(screen.getByTestId('chat-drop-box'));
    expect([box.borderStyle, box.borderTopWidth]).toEqual(['dashed', '2px']);
    const over = drag('dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    expect(document.activeElement).toBe(before);
  });

  test('goes when the drag leaves the window: by its depth, or a leave to nothing outside the viewport', () => {
    mount();
    const inner = document.createElement('div');
    document.body.append(inner);
    try {
      // Moving between the page's elements: the next one is entered before the last is left.
      drag('dragenter');
      drag('dragenter', {}, inner);
      drag('dragleave', { relatedTarget: inner });
      expect(overlay()).not.toBeNull();
      // Safari's leave names no element, but its point is inside the window.
      drag('dragenter');
      drag('dragleave', { relatedTarget: null, x: 300, y: 300 }, inner);
      expect(overlay()).not.toBeNull();
      // The depth alone: every element entered was left.
      drag('dragleave', { relatedTarget: null, x: 300, y: 300 });
      expect(overlay()).toBeNull();
      // A leave to nothing outside the window, even with a leave the page never heard.
      drag('dragenter');
      drag('dragenter', {}, inner);
      drag('dragleave', { relatedTarget: null, x: 0, y: 300 }, inner);
      expect(overlay()).toBeNull();
    } finally {
      inner.remove();
    }
  });

  test('a drop hides it, never lets the browser open the file, and gives the files to the page', () => {
    const { onFiles, onRefused } = mount();
    const dropped = new File(['Closed Mondays.'], 'hours.txt');
    drag('dragenter');
    const event = drag('drop', { files: [dropped] });
    expect(event.defaultPrevented).toBe(true);
    expect(overlay()).toBeNull();
    expect(onFiles).toHaveBeenCalledWith([dropped]);
    expect(onRefused).not.toHaveBeenCalled();
  });

  test('dragend, window blur and Escape hide it; after Escape it stays hidden until that drag ends', () => {
    mount();
    drag('dragenter');
    drag('dragend');
    expect(overlay()).toBeNull();
    drag('dragenter');
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(overlay()).toBeNull();
    drag('dragenter');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(overlay()).toBeNull();
    drag('dragover');
    expect(overlay()).toBeNull();
    drag('drop');
    drag('dragenter');
    expect(overlay()).not.toBeNull();
  });

  test('a watchdog hides it once no dragover has come for 400 ms', () => {
    jest.useFakeTimers();
    mount();
    drag('dragenter');
    act(() => { jest.advanceTimersByTime(WATCHDOG_MS - 1); });
    drag('dragover');
    act(() => { jest.advanceTimersByTime(WATCHDOG_MS - 1); });
    expect(overlay()).not.toBeNull();
    act(() => { jest.advanceTimersByTime(1); });
    expect(overlay()).toBeNull();
  });

  test('a drag that started on the page (a picture, a link) is not a drop of files', () => {
    const { onFiles } = mount();
    drag('dragstart');
    drag('dragenter');
    drag('drop');
    expect(overlay()).toBeNull();
    expect(onFiles).not.toHaveBeenCalled();
    drag('dragend');
    drag('dragenter');
    expect(overlay()).not.toBeNull();
  });

  test('when files can’t be attached it says why, shows no drop, and a drop opens nothing and attaches nothing', () => {
    const { onFiles, onRefused } = mount(DROP_BLOCKED.viewAs);
    drag('dragenter');
    const shown = overlay();
    if (shown === null) throw new Error('no overlay');
    expect(within(shown).getByText(DROP_BLOCKED.viewAs)).toBeTruthy();
    expect(within(shown).queryByText(DROP_KEPT)).toBeNull();
    const over = drag('dragover');
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('none');
    const event = drag('drop', { files: [new File(['x'], 'a.txt')] });
    expect(event.defaultPrevented).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  test('fades and scales in over theme.motion.select, and appears at once under reduced motion', async () => {
    mount();
    drag('dragenter');
    const box = screen.getByTestId('chat-drop-box');
    expect(overlay()?.style.opacity).toBe('0');
    expect(box.style.transform).toBe('scale(0.98)');
    expect(overlay()?.style.transition).toContain('150ms');
    await waitFor(() => { expect(overlay()?.style.opacity).toBe('1'); });
    expect(box.style.transform).toBe('scale(1)');
    cleanup();
    reduceMotion(true);
    mount();
    drag('dragenter');
    expect(overlay()?.style.opacity).toBe('1');
    expect(overlay()?.style.transition).toBe('none');
    expect(screen.getByTestId('chat-drop-box').style.transform).toBe('scale(1)');
  });
});

describe('on the TownwiseAI page', () => {
  const EMAIL = ['a', 'example.com'].join('@');

  function renderAgent(api: FakeChatApi, me: MeResponse = meOf(ACCESS.member)): ReturnType<typeof filesFake> {
    serveAbout(api);
    const files = filesFake({ inner: api, chunkSize: 1024 });
    files.lists[''] = [];
    const portal = fakePortalApi({ me, org: orgOf('member'), fallback: files });
    const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: portal });
    window.history.replaceState(null, '', '/locations/l1/agent');
    render(
      <Head.Provider>
        <ExpoRoot
          context={getMockContext(appRoutes(seededRoot(auth), {
            '(marketing)/index': () => null,
            '(gate)/sign-in': () => null,
            '(gate)/totp': () => null,
            '(gate)/auth/magic': () => null,
          }))}
          location="/locations/l1/agent"
        />
      </Head.Provider>,
    );
    return files;
  }

  async function layout(element: Element, height: number): Promise<void> {
    Object.defineProperty(element, 'offsetHeight', { configurable: true, get: () => height });
    const watching = observers.filter((observer) => observer.targets.has(element));
    await act(() => new Promise((resolve) => {
      for (const observer of watching) observer.callback([{ target: element } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
      setTimeout(resolve, 10);
    }));
  }

  async function openEarlierChat(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'Earlier chat, Nov 2, 2026' }));
    await screen.findByText('We close for the holidays.');
    return screen.getByRole('log', { name: 'Conversation with TownwiseAI' });
  }

  test('is drawn after the page’s body, outside the dock, which keeps its height, and the thread its end padding', async () => {
    const api = fakeChatApi();
    renderAgent(api);
    const log = await openEarlierChat();
    await screen.findByRole('button', { name: 'Attach files' });
    Object.defineProperty(log, 'scroll', { configurable: true, value: jest.fn() });
    const dock = screen.getByTestId('chat-dock');
    await layout(dock, 120);
    const content = log.children[0];
    if (content === undefined) throw new Error('no content');
    expect(getComputedStyle(content).paddingBottom).toBe('136px');
    const watching = observers.filter((observer) => observer.targets.has(dock));
    const calls = jest.fn();
    for (const observer of watching) {
      const was = observer.callback;
      observer.callback = (...args) => {
        calls();
        was(...args);
      };
    }
    drag('dragenter');
    const shown = overlay();
    if (shown === null) throw new Error('no overlay');
    expect(dock.contains(shown)).toBe(false);
    expect(log.contains(shown)).toBe(false);
    expect(dock.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing in the dock changed, so nothing measured it again.
    expect(calls).not.toHaveBeenCalled();
    expect(getComputedStyle(content).paddingBottom).toBe('136px');
    expect(log.style.scrollPaddingBottom).toBe('120px');
    // A wheel or a press anywhere passes through to the thread and the composer.
    expect(getComputedStyle(shown).pointerEvents).toBe('none');
    drag('dragleave', { relatedTarget: null, x: -1, y: 10 });
    expect(overlay()).toBeNull();
  });

  test('dropped files become the composer’s chips, uploaded as reference files, and the drop is announced', async () => {
    const api = fakeChatApi();
    const files = renderAgent(api);
    await screen.findByRole('button', { name: 'Attach files' });
    drag('dragenter');
    drag('drop', { files: [new File(['Closed Mondays.'], 'hours.txt')] });
    expect(overlay()).toBeNull();
    const chips = await screen.findByRole('list', { name: 'Files attached to your message' });
    expect(within(chips).getByText('hours.txt')).toBeTruthy();
    await waitFor(() => {
      expect(files.calls.find((call) => call.method === 'POST' && call.path === '/files')?.body).toMatchObject({ purpose: 'reference', name: 'hours.txt' });
    });
    expect(screen.getByTestId('chat-live').textContent).toBe('Attaching hours.txt to your message.');
    // Past the 5 a message carries: only what was attached is announced, and an alert says the rest weren't.
    drag('dragenter');
    drag('drop', { files: ['1', '2', '3', '4', '5', '6'].map((name) => new File(['x'], `${name}.txt`)) });
    expect(screen.getByTestId('chat-live').textContent).toBe('Attaching 4 files to your message.');
    expect(await screen.findByText('A message can carry 5 files, so 2 weren’t added.')).toBeTruthy();
  });

  test('under view-as the overlay says why, and a drop attaches nothing and says so as an alert', async () => {
    const api = fakeChatApi();
    const files = renderAgent(api, viewAsMe(ACCESS.member));
    await screen.findByRole('button', { name: 'Attach files' });
    drag('dragenter');
    expect(within(overlay() ?? document.body).getByText(DROP_BLOCKED.viewAs)).toBeTruthy();
    expect(drag('dragover').dataTransfer.dropEffect).toBe('none');
    expect(drag('drop', { files: [new File(['x'], 'a.txt')] }).defaultPrevented).toBe(true);
    expect(overlay()).toBeNull();
    const alert = await screen.findByText(DROP_BLOCKED.viewAs);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(files.calls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  test('while TownwiseAI loads, a drop is caught and attaches nothing', async () => {
    const api = fakeChatApi();
    // The chat's summary never answers.
    api.reads['/api/org/locations/l1/chat'] = () => new Promise(() => undefined);
    const files = renderAgent(api);
    await screen.findByText('Loading TownwiseAI…');
    drag('dragenter');
    expect(within(overlay() ?? document.body).getByText(DROP_BLOCKED.loading)).toBeTruthy();
    expect(drag('drop', { files: [new File(['x'], 'a.txt')] }).defaultPrevented).toBe(true);
    expect(files.calls.filter((call) => call.method === 'POST')).toEqual([]);
  });
});
