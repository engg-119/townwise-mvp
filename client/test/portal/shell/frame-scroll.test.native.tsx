import { router, Slot } from 'expo-router';
import { act, cleanup, renderRouter, screen } from 'expo-router/testing-library';
import { ScrollView, Text, View } from 'react-native';

import { Frame } from '../../../src/portal/shell/Frame';

// The frame around stand-in pages on native, through the real expo-router: a move to another path scrolls the frame to
// its top without animating, and a change of query on the same path keeps the scroll. The jest ScrollView keeps no
// offset, so these check the frame's scrollTo calls.

afterEach(async () => {
  await cleanup();
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

/**
 * The jest ScrollView's scrollTo is already a jest.fn shared by every instance, so spyOn hands back that same mock, with
 * the calls of earlier tests on it: clear them first.
 */
function spyScrollTo(): jest.SpyInstance {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  scrollTo.mockClear();
  return scrollTo;
}

test('a move to another page scrolls the frame to its top without animating, and mounting does not', async () => {
  const scrollTo = spyScrollTo();
  await renderRouter(ROUTES, { initialUrl: '/' });
  expect(screen.getByText('Home')).toBeTruthy();
  expect(scrollTo).not.toHaveBeenCalled();
  await act(() => { router.push('/notes'); });
  expect(await screen.findByText('Notes')).toBeTruthy();
  expect(scrollTo).toHaveBeenCalledTimes(1);
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, y: 0, animated: false });
});

test('a change of query on the same page keeps the scroll', async () => {
  const scrollTo = spyScrollTo();
  const rendered = await renderRouter(ROUTES, { initialUrl: '/calendar' });
  expect(screen.getByText('Calendar')).toBeTruthy();
  await act(() => { router.setParams({ day: '2026-11-21' }); });
  await act(() => { router.setParams({ view: 'week' }); });
  expect(rendered.getPathname()).toBe('/calendar');
  expect(rendered.getSearchParams()).toEqual({ day: '2026-11-21', view: 'week' });
  expect(scrollTo).not.toHaveBeenCalled();
});
