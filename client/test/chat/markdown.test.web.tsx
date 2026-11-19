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

it('opens http(s) links in a new tab with noopener, the host after each, and draws an unsafe one as text', async () => {
  show('[BLS](https://example.com/x) and [bad](mailto:a@example.com) [worse](javascript:alert(1))');
  const link = await screen.findByRole('link');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  // The host is written after the link, not inside it (D36).
  expect(link.textContent).toBe('BLS');
  expect(link.parentElement?.textContent).toContain('BLS (example.com) and bad');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByText('bad')).toBeTruthy();
  expect(screen.getByText(/\[worse\]\(javascript:alert\(1\)\)/)).toBeTruthy();
});

it('opens a Your data item\'s page in the app, not a new tab, with "(Your data)" after it (D63)', async () => {
  const href = `/locations/${'a'.repeat(24)}/data/c_${'b'.repeat(24)}`;
  show(`Added [Bookings](${href}).`);
  const link = await screen.findByRole('link');
  expect(link.getAttribute('href')).toBe(href);
  expect(link.getAttribute('target')).toBeNull();
  expect(link.textContent).toBe('Bookings');
  expect(link.parentElement?.textContent).toContain('Added Bookings (Your data).');
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
