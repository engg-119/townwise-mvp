import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, StyleSheet } from 'react-native';

import { SourceChips } from '../../../src/portal/ui/SourceChip';

// The source chip on native (source-chips: "Every source is a round chip with the site's logo and name" and "A chip is
// named by what it shows"): a 44px pressable around the pill, named by what it shows, with the logo hidden from screen
// readers or the globe for a host no manifest entry has; a press opens the source.

afterEach(() => {
  jest.restoreAllMocks();
});

/** A host element as the renderer gives it: its type, props and children. */
interface Host { type: unknown; props: Record<string, unknown>; children: readonly (Host | string)[] }

function descendants(node: Host): Host[] {
  return node.children.flatMap((child) => (typeof child === 'string' ? [] : [child, ...descendants(child)]));
}

/** The part of a chip that screen readers skip, and the host types drawn inside it. */
function hiddenPart(link: unknown): { props: Record<string, unknown>; types: string[] } {
  const part = descendants(link as Host).find((node) => node.props.accessibilityElementsHidden === true);
  if (part === undefined) throw new Error('no hidden part');
  return { props: part.props, types: descendants(part).map((node) => String(node.type)) };
}

const REGISTRAR = { label: 'Dartmouth Registrar, 2025-26 key dates', url: 'https://registrar.dartmouth.edu/calendars/2025-2026-key-dates' };
/** A host no manifest entry has: a fixture, since every host the shipped data cites is in sites.json. */
const UNKNOWN = { label: 'Sample events page', url: 'https://events.example.org/calendar' };

test('each chip is a 44px link named by what it shows, with no hitSlop, and a press opens its source', async () => {
  const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  await render(<SourceChips sources={[REGISTRAR, { ...REGISTRAR, label: 'Dartmouth Registrar, 2026-27 key dates', url: `${REGISTRAR.url}-2` }]} />);
  const first = screen.getByRole('link', { name: 'Dartmouth Registrar. Source: Dartmouth Registrar, 2025-26 key dates' });
  const second = screen.getByRole('link', { name: 'Dartmouth Registrar 2. Source: Dartmouth Registrar, 2026-27 key dates' });
  expect(screen.getByText('Dartmouth Registrar')).toBeTruthy();
  expect(screen.getByText('Dartmouth Registrar 2')).toBeTruthy();
  for (const link of [first, second]) {
    const style = StyleSheet.flatten(link.props.style as never) as { minHeight?: number; justifyContent?: string };
    expect(style.minHeight).toBe(44);
    expect(style.justifyContent).toBe('center');
    expect(link.props.hitSlop).toBeUndefined();
  }
  await fireEvent.press(second);
  expect(opened).toHaveBeenCalledWith(`${REGISTRAR.url}-2`);
});

test('the logo is hidden from screen readers; a host no manifest entry shows the globe and its host', async () => {
  await render(<SourceChips sources={[REGISTRAR, UNKNOWN]} />);
  const unknown = screen.getByRole('link', { name: 'events.example.org. Source: Sample events page' });
  expect(screen.getByText('events.example.org')).toBeTruthy();
  const known = screen.getByRole('link', { name: 'Dartmouth Registrar. Source: Dartmouth Registrar, 2025-26 key dates' });
  // The Registrar's committed logo (Dartmouth's) and the globe, each inside a part screen readers skip.
  const logo = hiddenPart(known);
  const globe = hiddenPart(unknown);
  for (const part of [logo, globe]) expect(part.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(logo.types).toContain('Image');
  expect(logo.types.some((type) => /svg/i.test(type))).toBe(false);
  expect(globe.types.some((type) => /svg/i.test(type))).toBe(true);
  expect(globe.types).not.toContain('Image');
});
