import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ExpoRoot, router, Slot } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';
import { Text, View } from 'react-native';

import { Frame } from '../../../src/portal/shell/Frame';

// The frame around stand-in pages on web, through the real expo-router: a move to another path (a push, browser back,
// or Home's This month opening a day in the Calendar) scrolls the frame to its top without animating, and a change of
// query on the same path keeps the scroll. jsdom keeps the scrollTop it is given, so these read it back.

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function Layout(): React.JSX.Element {
  return <Frame topBar={<Text>Top bar</Text>}><Slot /></Frame>;
}

function page(title: string): () => React.JSX.Element {
  return function Page() {
    return <View><Text>{title}</Text></View>;
  };
}

const ROUTES = { _layout: Layout, index: page('Home'), notes: page('Notes'), calendar: page('Calendar') };

/** Renders the stand-in pages at `path` and returns the frame's scroll node, scrolled down 1,200px. */
async function renderScrolled(path: string, title: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', path);
  render(<ExpoRoot context={getMockContext(ROUTES)} location={path} />);
  await screen.findByText(title);
  // react-native-web draws <main> inside the scroll view's content container, inside the scroll node.
  const node = screen.getByRole('main').parentElement?.parentElement;
  if (node === null || node === undefined) throw new Error('no scroll node');
  node.scrollTop = 1200;
  return node;
}

test('a move to another page opens it at its top, without animating', async () => {
  const node = await renderScrolled('/', 'Home');
  const scrollTo = jest.spyOn(node, 'scrollTo');
  act(() => { router.push('/notes'); });
  await screen.findByText('Notes');
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
  expect(node.scrollTop).toBe(0);
});

test('browser back opens the page at its top too', async () => {
  const node = await renderScrolled('/', 'Home');
  act(() => { router.push('/notes'); });
  await screen.findByText('Notes');
  node.scrollTop = 1200;
  act(() => { router.back(); });
  await waitFor(() => { expect(window.location.pathname).toBe('/'); });
  await screen.findByText('Home');
  expect(node.scrollTop).toBe(0);
});

test('a day opened in the Calendar from Home opens the Calendar at its top', async () => {
  const node = await renderScrolled('/', 'Home');
  act(() => { router.push('/calendar?day=2026-11-21'); });
  await screen.findByText('Calendar');
  expect(window.location.search).toBe('?day=2026-11-21');
  expect(node.scrollTop).toBe(0);
});

test('a change of query on the same page keeps the scroll', async () => {
  const node = await renderScrolled('/calendar', 'Calendar');
  const scrollTo = jest.spyOn(node, 'scrollTo');
  act(() => { router.setParams({ day: '2026-11-21' }); });
  await waitFor(() => { expect(window.location.search).toBe('?day=2026-11-21'); });
  act(() => { router.setParams({ view: 'week' }); });
  await waitFor(() => { expect(window.location.search).toBe('?day=2026-11-21&view=week'); });
  expect(window.location.pathname).toBe('/calendar');
  expect(scrollTo).not.toHaveBeenCalled();
  expect(node.scrollTop).toBe(1200);
});
