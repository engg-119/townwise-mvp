import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { PortalStyles } from '../../../src/portal/shell/PortalStyles';
import { Button } from '../../../src/portal/ui/Button';
import { InlineNotice, Notice } from '../../../src/portal/ui/feedback';
import { MessageFocus, useFocusFallback, useFocusMessage } from '../../../src/portal/ui/messageFocus';
import { Title } from '../../../src/portal/ui/text';
import { ToastHost, useToast, type ToastApi } from '../../../src/portal/ui/toast';
import { theme } from '../../../src/theme';

// Toasts on web (spec 15.7, D55): what an action did shows at the bottom of the window in a polite live region that is
// there before the first toast, leaves by itself (6 seconds, never while the pointer or focus is on it, and never
// when it has a link), and can be dismissed with its button or Escape. At most three show; the rest wait. A notice under the host is
// a toast and no row in the page; without a host it is the row it always was.

jest.mock('expo-router', () => ({
  Link: (props: { href: string; children: React.ReactNode }) => <a href={props.href}>{props.children}</a>,
}));

let reduced = false;

beforeEach(() => {
  jest.useFakeTimers();
  reduced = false;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'), media: query,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    }),
  });
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

let api: ToastApi | null = null;

function Grab(): null {
  const toast = useToast();
  useEffect(() => { api = toast; }, [toast]);
  return null;
}

function host(children?: React.ReactNode): HTMLElement {
  render(<ToastHost><Grab />{children}</ToastHost>);
  return screen.getByRole('status');
}

function show(text: string, link?: { label: string; href: string }): void {
  act(() => { api?.show(link === undefined ? { text } : { text, link }); });
}

function wait(ms: number): void {
  act(() => { jest.advanceTimersByTime(ms); });
}

/** The toasts on screen, top to bottom. */
function shown(region: HTMLElement): string[] {
  return within(region).queryAllByTestId('toast').map((card) => within(card).getByTestId('toast-text').textContent);
}

function card(region: HTMLElement, text: string): HTMLElement {
  const found = within(region).getAllByTestId('toast').find((each) => each.textContent.includes(text));
  if (found === undefined) throw new Error(`no toast says ${text}`);
  return found;
}

test('the region is a polite live region before any toast, and a toast shows its words in it', () => {
  const region = host();
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(region.getAttribute('aria-atomic')).toBe('false');
  expect(shown(region)).toEqual([]);
  show('Saved.');
  expect(shown(region)).toEqual(['Saved.']);
  expect(within(region).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
});

test('a toast leaves after 6 seconds, and one with a link stays until it is dismissed', () => {
  const region = host();
  show('Saved.');
  wait(5999);
  expect(shown(region)).toEqual(['Saved.']);
  wait(1);
  expect(shown(region)).toEqual([]);

  show('Rejected the request for Sample.', { label: 'See rejected requests', href: '/admin?status=rejected' });
  const link = within(region).getByRole('link', { name: 'See rejected requests' });
  expect(link.getAttribute('href')).toBe('/admin?status=rejected');
  expect(shown(region)).toEqual(['Rejected the request for Sample. See rejected requests.']);
  // The region is last on the page: a keyboard or a screen reader may need longer than any timer to reach the link.
  wait(10 * 60 * 1000);
  expect(shown(region)).toHaveLength(1);
  fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
  expect(shown(region)).toEqual([]);
});

test('while held (a statement moment covers the frame) toasts wait unseen, then show with their full time', () => {
  const region = host();
  act(() => { api?.hold(true); });
  show('You joined Test Group.');
  expect(shown(region)).toEqual([]);
  wait(20000);
  act(() => { api?.hold(false); });
  expect(shown(region)).toEqual(['You joined Test Group.']);
  wait(5999);
  expect(shown(region)).toEqual(['You joined Test Group.']);
  wait(1);
  expect(shown(region)).toEqual([]);
});

test('the region has the id the portal’s stylesheet gives its focus ring and antialiasing to', () => {
  const region = host();
  expect(region.id).toBe('tw-toasts');
  render(<PortalStyles />);
  const css = [...document.querySelectorAll('style')].map((element) => element.textContent).find((text) => text.includes('#tw-toasts'));
  expect(css).toContain('#tw-toasts{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}');
  expect(css).toContain(`#tw-toasts :focus-visible{outline:2px solid ${theme.color.focusRing};outline-offset:2px}`);
  expect(css).toContain('#tw-toasts :focus:not(:focus-visible){outline:none}');
});

describe('dismissing with focus in the toast', () => {
  function page(heading: boolean): HTMLElement {
    return host(
      <View role="main" tabIndex={-1}>
        {heading ? <MessageFocus><Title>Notes</Title></MessageFocus> : <Title>Notes</Title>}
      </View>,
    );
  }

  test('Escape sends focus to the page’s heading, not to the body', () => {
    const region = page(true);
    show('Saved.');
    const button = within(region).getByRole('button', { name: 'Dismiss' });
    act(() => { button.focus(); });
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(shown(region)).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Notes' }));
  });

  test('the Dismiss button sends it to <main> where the heading cannot take focus', () => {
    const region = page(false);
    show('Saved.');
    const button = within(region).getByRole('button', { name: 'Dismiss' });
    act(() => { button.focus(); });
    fireEvent.click(button);
    expect(shown(region)).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  test('dismissed by the pointer with focus elsewhere, focus stays where it was', () => {
    const region = host(<View role="main" tabIndex={-1}><Button label="Save" onPress={() => undefined} /></View>);
    const save = screen.getByRole('button', { name: 'Save' });
    act(() => { save.focus(); });
    show('Saved.');
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    expect(document.activeElement).toBe(save);
  });
});

test('the timer waits while the pointer is over the toast or focus is in it, and starts over after', () => {
  const region = host();
  show('Saved.');
  wait(5000);
  fireEvent.mouseEnter(card(region, 'Saved.'));
  wait(20000);
  expect(shown(region)).toEqual(['Saved.']);
  fireEvent.mouseLeave(card(region, 'Saved.'));
  wait(5999);
  expect(shown(region)).toEqual(['Saved.']);
  act(() => { within(region).getByRole('button', { name: 'Dismiss' }).focus(); });
  wait(20000);
  expect(shown(region)).toEqual(['Saved.']);
  act(() => { within(region).getByRole('button', { name: 'Dismiss' }).blur(); });
  wait(6000);
  expect(shown(region)).toEqual([]);
});

test('the dismiss button and Escape in a toast take it away at once', () => {
  const region = host();
  show('Saved.');
  show('Deleted the note.');
  fireEvent.click(within(card(region, 'Saved.')).getByRole('button', { name: 'Dismiss' }));
  expect(shown(region)).toEqual(['Deleted the note.']);
  const button = within(region).getByRole('button', { name: 'Dismiss' });
  act(() => { button.focus(); });
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(shown(region)).toEqual([]);
});

test('the newest toast is on top, three show at most and the rest wait their turn with a full timer', () => {
  const region = host();
  show('One.');
  wait(2000);
  show('Two.');
  show('Three.');
  show('Four.');
  show('Five.');
  expect(shown(region)).toEqual(['Three.', 'Two.', 'One.']);
  wait(4000);
  // One left at its 6 seconds; Four took the free place and has 6 seconds of its own.
  expect(shown(region)).toEqual(['Four.', 'Three.', 'Two.']);
  wait(2000);
  expect(shown(region)).toEqual(['Five.', 'Four.']);
  wait(3999);
  expect(shown(region)).toEqual(['Five.', 'Four.']);
  wait(1);
  expect(shown(region)).toEqual(['Five.']);
  wait(2000);
  expect(shown(region)).toEqual([]);
});

test('the same words twice within a second show once; later, while still up, they stay one toast with a new timer', () => {
  const region = host();
  show('Saved.');
  wait(500);
  show('Saved.');
  expect(shown(region)).toEqual(['Saved.']);
  // The second one within the second changed nothing: the toast leaves 6 seconds after the first.
  wait(5500);
  expect(shown(region)).toEqual([]);

  show('Saved.');
  wait(3000);
  show('Saved.');
  expect(shown(region)).toEqual(['Saved.']);
  wait(5999);
  expect(shown(region)).toEqual(['Saved.']);
  wait(1);
  expect(shown(region)).toEqual([]);
  // Different words are different toasts, however close.
  show('Saved.');
  show('Deleted the note.');
  expect(shown(region)).toEqual(['Deleted the note.', 'Saved.']);
});

// Animated runs to its end at once under jest, so the slide shows only as the style it animates.
test('a toast slides and fades in, and with reduced motion it is simply there', () => {
  const region = host();
  show('Saved.');
  expect(card(region, 'Saved.').style.transform).toContain('translateY');
  expect(card(region, 'Saved.').style.opacity).toBe('1');
  cleanup();

  reduced = true;
  const still = host();
  show('Saved.');
  expect(card(still, 'Saved.').style.transform).toBe('');
  expect(card(still, 'Saved.').style.opacity).toBe('');
});

test('a toast never takes focus', () => {
  const region = host(<Button label="Save" onPress={() => undefined} />);
  const save = screen.getByRole('button', { name: 'Save' });
  act(() => { save.focus(); });
  show('Saved.');
  expect(shown(region)).toEqual(['Saved.']);
  expect(document.activeElement).toBe(save);
  wait(6000);
  expect(document.activeElement).toBe(save);
});

describe('Notice', () => {
  function Page(props: { inline?: boolean }): React.JSX.Element {
    const [notice, setNotice] = useState<string | null>(null);
    return (
      <div data-testid="page">
        {notice === null ? null : props.inline === true ? <InlineNotice text={notice} /> : <Notice text={notice} />}
        <Button label="Save" onPress={() => { setNotice('Saved.'); }} />
        <Button label="Save again" onPress={() => { setNotice('Saved. The forecast now includes its 40 guests.'); }} />
        <Button label="Clear" onPress={() => { setNotice(null); }} />
      </div>
    );
  }

  test('under a host it is a toast and no row in the page, and the toast outlives the notice', () => {
    const region = host(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(shown(region)).toEqual(['Saved.']);
    expect(within(screen.getByTestId('page')).queryByText('Saved.')).toBeNull();
    expect(within(screen.getByTestId('page')).queryByText('01')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(shown(region)).toEqual(['Saved.']);
    wait(6000);
    expect(shown(region)).toEqual([]);
  });

  test('a notice whose words change changes its toast in place', () => {
    const region = host(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    wait(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Save again' }));
    expect(shown(region)).toEqual(['Saved. The forecast now includes its 40 guests.']);
    wait(5999);
    expect(shown(region)).toHaveLength(1);
    wait(1);
    expect(shown(region)).toEqual([]);
  });

  test('React’s strict double effects show one toast', () => {
    render(<ToastHost><Grab /><Notice text="Saved." /></ToastHost>, { reactStrictMode: true });
    expect(shown(screen.getByRole('status'))).toEqual(['Saved.']);
  });

  test('a notice for one result toasts once, however often it mounts, and again for the next result', () => {
    const first = { text: 'Saved.' };
    const view = render(<ToastHost><Grab /><Notice text={first.text} result={first} /></ToastHost>);
    const region = screen.getByRole('status');
    expect(shown(region)).toEqual(['Saved.']);
    wait(6000);
    view.rerender(<ToastHost><Grab /></ToastHost>);
    view.rerender(<ToastHost><Grab /><Notice text={first.text} result={first} /></ToastHost>);
    expect(shown(region)).toEqual([]);
    view.rerender(<ToastHost><Grab /><Notice text="Saved." result={{ text: 'Saved.' }} /></ToastHost>);
    expect(shown(region)).toEqual(['Saved.']);
  });

  test('without a host it is the row in the page it always was', () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const line = within(screen.getByTestId('page')).getByText('Saved.');
    expect(line.getAttribute('role')).toBe('status');
    expect(within(screen.getByTestId('page')).getByText('01')).toBeTruthy();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  test('an inline notice stays a row in the page under a host', () => {
    const region = host(<Page inline />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(shown(region)).toEqual([]);
    expect(within(screen.getByTestId('page')).getByText('Saved.').getAttribute('role')).toBe('status');
  });
});

describe('focus after an action that took its control away', () => {
  function Remove(props: { children: React.ReactNode }): React.JSX.Element {
    const [gone, setGone] = useState(false);
    const focusMessage = useFocusMessage();
    return (
      <>
        {gone ? props.children : <Button label="Remove" onPress={() => { focusMessage(); setGone(true); }} />}
      </>
    );
  }

  test('under a host focus goes to the page’s heading, not to the toast', () => {
    const region = host(<MessageFocus><Title>Team</Title><Remove><Notice text="Removed Kitchen." /></Remove></MessageFocus>);
    const remove = screen.getByRole('button', { name: 'Remove' });
    act(() => { remove.focus(); });
    fireEvent.click(remove);
    expect(shown(region)).toEqual(['Removed Kitchen.']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Team' }));
    expect(region.contains(document.activeElement)).toBe(false);
  });

  test('a MessageFocus with no heading of its own uses the one around it', () => {
    host(<MessageFocus><Title>Data</Title><MessageFocus><Remove><Notice text="Deleted the file." /></Remove></MessageFocus></MessageFocus>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Data' }));
  });

  test('a landmark that arrives after its hook (a panel that loads) still takes focus', () => {
    function Panel(props: { children: React.ReactNode }): React.JSX.Element {
      const [loaded, setLoaded] = useState(false);
      const fallback = useFocusFallback<React.ComponentRef<typeof View>>();
      return (
        <>
          <Button label="Load" onPress={() => { setLoaded(true); }} />
          {loaded ? <View role="region" aria-label="Selected day" {...fallback}>{props.children}</View> : null}
        </>
      );
    }
    host(<MessageFocus><Title>Calendar</Title><Panel><Remove><Notice text="Deleted the note." /></Remove></Panel></MessageFocus>);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Selected day' }));
  });

  test('without a host focus still goes to the notice', () => {
    render(<MessageFocus><Title>Team</Title><Remove><Notice text="Removed Kitchen." /></Remove></MessageFocus>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(document.activeElement?.textContent).toContain('Removed Kitchen.');
  });
});
