import { act, render, screen, waitFor } from '@testing-library/react';

import { GoogleButton, resetGoogleButtonState } from '../../src/auth/GoogleButton';
import { REVEAL_MS, SWAP_GRACE_MS } from '../../src/auth/GoogleButton.web';

const GIS = 'https://accounts.google.com/gsi/client';
const google = { webClientId: '123-abc.apps.googleusercontent.com', iosClientId: null };

beforeEach(() => {
  resetGoogleButtonState();
  delete (window as { google?: unknown }).google;
});

test('script injected once across remounts', async () => {
  const props = { google, onIdToken: jest.fn(), onError: jest.fn() };
  const first = render(<GoogleButton {...props} />);
  await waitFor(() => { expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1); });
  first.unmount();
  render(<GoogleButton {...props} />);
  expect(document.querySelectorAll(`script[src="${GIS}"]`)).toHaveLength(1);
});

test('initialize called once', async () => {
  const initialize = jest.fn();
  const renderButton = jest.fn();
  (window as { google?: unknown }).google = { accounts: { id: { initialize, renderButton } } };
  const props = { google, onIdToken: jest.fn(), onError: jest.fn() };
  const first = render(<GoogleButton {...props} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  await waitFor(() => { expect(initialize).toHaveBeenCalledTimes(1); });
  first.unmount();
  render(<GoogleButton {...props} />);
  await waitFor(() => { expect(renderButton.mock.calls.length).toBeGreaterThan(0); });
  expect(initialize).toHaveBeenCalledTimes(1);
});

test('the credential reaches the mounted handler', async () => {
  let callback: ((response: { credential?: string }) => void) | undefined;
  const initialize = jest.fn((config: { callback: (response: { credential?: string }) => void }) => { callback = config.callback; });
  (window as { google?: unknown }).google = { accounts: { id: { initialize, renderButton: jest.fn() } } };
  const onIdToken = jest.fn();
  render(<GoogleButton google={google} onIdToken={onIdToken} onError={jest.fn()} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  await waitFor(() => { expect(initialize).toHaveBeenCalled(); });
  callback?.({ credential: 'gis-token' });
  expect(onIdToken).toHaveBeenCalledWith('gis-token');
});

test('load failure shows the unavailable message, as an alert screen readers announce', async () => {
  render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('error'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.');
  expect(alert.getAttribute('aria-live')).toBe('assertive');
});

test('after a load failure, the next mount injects a fresh tag', async () => {
  const first = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  const failed = document.querySelector(`script[src="${GIS}"]`);
  failed?.dispatchEvent(new Event('error'));
  await screen.findByText('Google sign-in didn’t load. Check your connection, turn off any blocker for accounts.google.com, and reload.');
  expect(document.querySelector(`script[src="${GIS}"]`)).toBeNull();
  first.unmount();
  render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  await waitFor(() => { expect(document.querySelector(`script[src="${GIS}"]`)).not.toBeNull(); });
});

// Google's renderButton as it behaves: a placeholder, then its button in an iframe that is 0 wide until it loads.
function fakeGis(): { renderButton: jest.Mock; frames: HTMLIFrameElement[] } {
  const frames: HTMLIFrameElement[] = [];
  const renderButton = jest.fn((parent: HTMLElement) => {
    const frame = document.createElement('iframe');
    frames.push(frame);
    parent.append(document.createElement('div'), frame);
  });
  (window as { google?: unknown }).google = { accounts: { id: { initialize: jest.fn(), renderButton } } };
  return { renderButton, frames };
}

class FakeSizes {
  static all: FakeSizes[] = [];
  readonly callback: ResizeObserverCallback;
  readonly targets: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeSizes.all.push(this);
  }
  observe(target: Element): void { this.targets.push(target); }
  unobserve(): void { return undefined; }
  disconnect(): void { this.targets.length = 0; }
  report(target: Element, width: number): void {
    this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this);
  }
}

function withSizes(): () => void {
  const had = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  FakeSizes.all = [];
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: FakeSizes });
  return () => {
    if (had === undefined) delete (window as { ResizeObserver?: unknown }).ResizeObserver;
    else Object.defineProperty(window, 'ResizeObserver', had);
  };
}

/** The skeleton drawn in the button's place until Google's button is ready. */
function skeletonOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[data-skeleton="google"]');
}

/** Google's button is showing: the element it drew into is visible and the skeleton is gone. */
function buttonShown(host: HTMLElement): boolean {
  const drawn = host.querySelector('iframe')?.parentElement;
  return drawn !== null && drawn !== undefined && drawn.style.visibility !== 'hidden' && skeletonOf(host) === null;
}

async function mountButton(): Promise<HTMLElement> {
  const { container } = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
  const host = container.firstElementChild as HTMLElement;
  await waitFor(() => { expect(host.querySelector('iframe')).not.toBeNull(); });
  return host;
}

test('the button gets the container’s width, from 200 to 400px, so Google’s placeholder and its button match', async () => {
  for (const [width, expected] of [[363, 363], [520, 400], [150, 200]] as const) {
    resetGoogleButtonState();
    const { renderButton } = fakeGis();
    const spy = jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    const view = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
    document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
    await waitFor(() => { expect(renderButton).toHaveBeenCalledWith(expect.any(HTMLElement), { text: 'continue_with', width: expected }); });
    spy.mockRestore();
    view.unmount();
  }
});

test('a skeleton shaped like Google’s button shows at once in the 44px box, before Google’s script has loaded', () => {
  fakeGis();
  const { container } = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
  const host = container.firstElementChild as HTMLElement;
  expect(host.style.height).toBe('44px');
  const skeleton = skeletonOf(host);
  expect(skeleton).not.toBeNull();
  expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
  expect(skeleton?.style.height).toBe('40px');
  expect(skeleton?.style.borderRadius).toBe('4px');
  expect(skeleton?.style.maxWidth).toBe('400px');
});

test('Google’s button replaces the skeleton, with no fade, once its iframe has its size', async () => {
  const restore = withSizes();
  try {
    const { frames } = fakeGis();
    const host = await mountButton();
    expect(host.style.height).toBe('44px');
    expect(buttonShown(host)).toBe(false);
    const sizes = FakeSizes.all.at(-1);
    const frame = frames.at(-1);
    if (sizes === undefined || frame === undefined) throw new Error('nothing observed');
    expect(sizes.targets).toEqual([frame]);
    // The iframe starts 0 wide: the skeleton stays.
    act(() => { sizes.report(frame, 0); });
    expect(buttonShown(host)).toBe(false);
    act(() => { sizes.report(frame, 363); });
    expect(buttonShown(host)).toBe(true);
    const drawn = frame.parentElement;
    expect(drawn?.style.transition).toBe('');
    expect(drawn?.style.opacity).toBe('');
    expect(host.style.height).toBe('44px');
  } finally {
    restore();
  }
});

test('if Google’s iframe never takes a size, the button shows after REVEAL_MS', async () => {
  const restore = withSizes();
  jest.useFakeTimers();
  try {
    fakeGis();
    const { container } = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
    document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const host = container.firstElementChild as HTMLElement;
    expect(host.querySelector('iframe')).not.toBeNull();
    act(() => { jest.advanceTimersByTime(REVEAL_MS - 1); });
    expect(buttonShown(host)).toBe(false);
    act(() => { jest.advanceTimersByTime(1); });
    expect(buttonShown(host)).toBe(true);
  } finally {
    jest.useRealTimers();
    restore();
  }
});

test('if Google’s iframe loads and stays 0 wide (no personalized button), its placeholder shows SWAP_GRACE_MS later', async () => {
  const restore = withSizes();
  jest.useFakeTimers();
  try {
    const { frames } = fakeGis();
    const { container } = render(<GoogleButton google={google} onIdToken={jest.fn()} onError={jest.fn()} />);
    document.querySelector(`script[src="${GIS}"]`)?.dispatchEvent(new Event('load'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const host = container.firstElementChild as HTMLElement;
    const frame = frames.at(-1);
    if (frame === undefined) throw new Error('no iframe');
    act(() => { frame.dispatchEvent(new Event('load')); });
    act(() => { jest.advanceTimersByTime(SWAP_GRACE_MS - 1); });
    expect(buttonShown(host)).toBe(false);
    act(() => { jest.advanceTimersByTime(1); });
    expect(buttonShown(host)).toBe(true);
    expect(SWAP_GRACE_MS).toBeLessThan(REVEAL_MS);
  } finally {
    jest.useRealTimers();
    restore();
  }
});

test('without ResizeObserver the button shows as soon as Google draws it', async () => {
  expect(typeof (window as { ResizeObserver?: unknown }).ResizeObserver).toBe('undefined');
  fakeGis();
  const host = await mountButton();
  await waitFor(() => { expect(buttonShown(host)).toBe(true); });
});
