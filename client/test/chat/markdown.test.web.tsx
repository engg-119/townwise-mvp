import { cleanup, render, screen } from '@testing-library/react';
import { ExpoRoot } from 'expo-router';
import { getMockContext } from 'expo-router/testing-library';

import { Markdown } from '../../src/chat/markdown/Markdown';

// The Markdown renderer on web (spec P25): links open in a new tab, a table is a focusable scroll region, the caret
// is hidden from assistive tech, and long words wrap.

function show(source: string, caret?: boolean): void {
  render(
    <ExpoRoot context={getMockContext({ index: () => <Markdown source={source} {...(caret === undefined ? null : { caret })} /> })} />,
  );
}

afterEach(cleanup);

it('opens http(s) links in a new tab with noopener, and draws an unsafe one as text', async () => {
  show('[BLS](https://example.com/x) and [bad](mailto:a@example.com) [worse](javascript:alert(1))');
  const link = await screen.findByRole('link');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByText('bad')).toBeTruthy();
  expect(screen.getByText(/\[worse\]\(javascript:alert\(1\)\)/)).toBeTruthy();
});

it('puts a table in a focusable region named Table that scrolls inside itself', async () => {
  show('| Day | Note |\n|---|---|\n| Mon | Closed |');
  const region = await screen.findByRole('region', { name: 'Table' });
  expect(region.getAttribute('tabindex')).toBe('0');
});

it('draws the caret only when asked, hidden from assistive tech', async () => {
  show('Hello');
  await screen.findByText('Hello');
  expect(screen.queryByText('▍')).toBeNull();
  cleanup();
  show('Hello', true);
  const caret = await screen.findByText('▍');
  expect(caret.getAttribute('aria-hidden')).toBe('true');
});

it('lets long words wrap', async () => {
  show('A very long word');
  const paragraph = await screen.findByText('A very long word');
  expect(paragraph.parentElement?.style.overflowWrap).toBe('anywhere');
});
