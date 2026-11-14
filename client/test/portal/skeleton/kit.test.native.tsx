import { AccessibilityInfo, Animated, Dimensions, StyleSheet } from 'react-native';
import { act, isHiddenFromAccessibility, render, screen, within } from '@testing-library/react-native';

import {
  PULSE, Skeleton, SkeletonButton, SkeletonChart, SkeletonField, SkeletonFigure, SkeletonHeading, SkeletonTable, SkeletonText,
} from '../../../src/portal/skeleton';
import { theme } from '../../../src/theme';

// The skeleton kit on native (spec 15.7 Loading): each shape reserves its content's size, the pulse is opacity only
// and still under Reduce Motion (and until the system answers), and screen readers hear one status line.

afterEach(() => {
  jest.restoreAllMocks();
});

/** The system's Reduce Motion answer, or none yet. */
function reduceMotion(answer: boolean | null): void {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(answer === null ? new Promise(() => undefined) : Promise.resolve(answer));
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockReturnValue({ remove: () => undefined });
}

function widthOf(width: number): void {
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 2, fontScale: 1 });
}

/** A fake loop, so the test sees what was started without running it. */
function fakeLoop(): { loop: jest.SpyInstance; start: jest.Mock; stop: jest.Mock } {
  const start = jest.fn();
  const stop = jest.fn();
  const loop = jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() });
  return { loop, start, stop };
}

interface Node { type: string; props: Record<string, unknown>; children: (Node | string)[] | null }

function styleOf(node: Node | string | undefined): Record<string, unknown> {
  if (node === undefined || typeof node === 'string') throw new Error('no node');
  return (StyleSheet.flatten(node.props.style as never) as Record<string, unknown> | undefined) ?? {};
}

function kids(node: Node | string | undefined): Node[] {
  if (node === undefined || typeof node === 'string') throw new Error('no node');
  return (node.children ?? []).filter((child): child is Node => typeof child !== 'string');
}

function root(): Node {
  const tree = screen.toJSON() as Node | Node[] | null;
  if (tree === null || Array.isArray(tree)) throw new Error('expected one root');
  return tree;
}

/** Every style in the tree, flattened. */
function styles(node: Node): Record<string, unknown>[] {
  return [styleOf(node), ...kids(node).flatMap(styles)];
}

describe('accessibility', () => {
  test('one polite status line with the loading words; the shapes are hidden from assistive tech', async () => {
    reduceMotion(false);
    fakeLoop();
    await render(
      <Skeleton name="team" label="Loading your team">
        <SkeletonHeading kicker />
        <SkeletonTable columns={[{}, {}]} />
      </Skeleton>,
    );
    const skeleton = screen.getByTestId('skeleton-team');
    const status = within(skeleton).getByRole('status');
    expect(status.props.children).toBe('Loading your team');
    expect(status.props['aria-live']).toBe('polite');
    expect(isHiddenFromAccessibility(status)).toBe(false);
    const shapes = within(skeleton).getByTestId('skeleton-shapes', { includeHiddenElements: true });
    expect(isHiddenFromAccessibility(shapes)).toBe(true);
    // Nothing else in it is text: the shapes never suggest a value.
    expect(within(skeleton).getAllByText(/./, { includeHiddenElements: true })).toHaveLength(1);
  });
});

describe('motion', () => {
  test('the pulse is a loop of opacity, between 1 and the low point, stopped when the skeleton goes', async () => {
    reduceMotion(false);
    const { loop, start, stop } = fakeLoop();
    const timing = jest.spyOn(Animated, 'timing');
    const view = await render(<Skeleton name="x" label="Loading"><SkeletonText /></Skeleton>);
    await act(async () => { await Promise.resolve(); });
    expect(loop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls.map(([, config]) => [config.toValue, config.duration, config.useNativeDriver])).toEqual([
      [PULSE.low, PULSE.cycleMs / 2, true],
      [1, PULSE.cycleMs / 2, true],
    ]);
    // One value, the shapes' opacity, which starts at 1.
    const [first, second] = timing.mock.calls.map(([value]) => value);
    expect(first).toBeInstanceOf(Animated.Value);
    expect(second).toBe(first);
    expect(styleOf(kids(root())[1])).toEqual({ opacity: 1 });
    await view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test.each([['under Reduce Motion', true], ['until the system answers', null]])('still at full opacity %s', async (_name, answer) => {
    reduceMotion(answer);
    const { loop } = fakeLoop();
    await render(<Skeleton name="x" label="Loading"><SkeletonText /></Skeleton>);
    await act(async () => { await Promise.resolve(); });
    expect(loop).not.toHaveBeenCalled();
    const shapes = screen.getByTestId('skeleton-shapes', { includeHiddenElements: true });
    expect(StyleSheet.flatten(shapes.props.style as never)).toMatchObject({ opacity: 1 });
  });
});

describe('sizes', () => {
  test('text lines reserve their type’s line height, with a bar the type’s size; small text is 16/24 on phones', async () => {
    widthOf(1280);
    const view = await render(<SkeletonText lines={3} />);
    const lines = kids(root());
    expect(lines.map((line) => styleOf(line).height)).toEqual([20, 20, 20]);
    expect(lines.map((line) => styleOf(kids(line)[0]).height)).toEqual([14, 14, 14]);
    expect(styleOf(kids(lines[2])[0]).width).toBe('60%');
    await view.unmount();

    widthOf(375);
    await render(<SkeletonText lines={2} />);
    expect(kids(root()).map((line) => styleOf(line).height)).toEqual([24, 24]);
  });

  test('a heading is the eyebrow 8px above an h3, 28px tall (24 on phones)', async () => {
    widthOf(1280);
    const view = await render(<SkeletonHeading kicker />);
    const [kicker, title] = kids(root());
    expect(styleOf(root()).gap).toBe(8);
    expect(styleOf(kids(kicker)[0]).height).toBe(16);
    expect(styleOf(title).height).toBe(28);
    await view.unmount();

    widthOf(375);
    await render(<SkeletonHeading />);
    expect(kids(root()).map((line) => styleOf(line).height)).toEqual([24]);
  });

  test('a figure is the 56px value (40 on phones) over its label', async () => {
    widthOf(1280);
    const view = await render(<SkeletonFigure />);
    expect(styleOf(kids(root())[0]).height).toBe(56);
    await view.unmount();
    widthOf(375);
    await render(<SkeletonFigure />);
    expect(styleOf(kids(root())[0]).height).toBe(40);
  });

  test('a field is its label, the 44px input outlined in line, and its helper; a button is 44px', async () => {
    const view = await render(<SkeletonField helper />);
    const [label, input, helper] = kids(root());
    expect(styleOf(kids(label)[0]).height).toBe(20);
    expect(styleOf(input)).toMatchObject({ height: 44, borderWidth: 1, borderColor: theme.color.line });
    expect(styleOf(kids(helper)[0]).height).toBe(20);
    await view.unmount();
    await render(<SkeletonButton />);
    expect(styleOf(root())).toMatchObject({ minHeight: 44, borderColor: theme.color.line });
  });

  test('a chart area keeps the chart’s height', async () => {
    await render(<SkeletonChart height={196} />);
    expect(styleOf(root())).toMatchObject({ height: 196, backgroundColor: theme.color.raised });
  });

  test('a table keeps its columns: a head row and rows of at least 44px, with the same flex; stacked pairs on phones', async () => {
    widthOf(1280);
    const columns = [{ flex: 1.6 }, { flex: 0.7 }, {}, { flex: 1.4 }];
    const view = await render(<SkeletonTable columns={columns} rows={2} rowHeight={56} />);
    const [head, ...rows] = kids(kids(root())[0]);
    expect(kids(head).map((cell) => styleOf(cell).flex)).toEqual([1.6, 0.7, 1, 1.4]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => styleOf(row).minHeight)).toEqual([56, 56]);
    expect(rows.map((row) => kids(row).length)).toEqual([4, 4]);
    expect(styleOf(rows[1]).borderBottomWidth).toBe(0);
    await view.unmount();

    widthOf(375);
    await render(<SkeletonTable columns={columns} rows={2} />);
    const stacked = kids(root());
    expect(stacked).toHaveLength(2);
    expect(stacked.map((row) => kids(row).length)).toEqual([4, 4]);
  });

  test('a table that stays one table on phones keeps its columns there', async () => {
    widthOf(375);
    await render(<SkeletonTable columns={[{ flex: 1.4 }, { numeric: true }, { numeric: true }]} rows={2} stack={false} />);
    const [head] = kids(kids(root())[0]);
    expect(kids(head)).toHaveLength(3);
  });
});

test('square, raised or line, never mint', async () => {
  reduceMotion(true);
  widthOf(1280);
  await render(
    <Skeleton name="x" label="Loading">
      <SkeletonHeading kicker />
      <SkeletonText lines={2} />
      <SkeletonFigure />
      <SkeletonField helper />
      <SkeletonButton />
      <SkeletonChart height={120} />
      <SkeletonTable columns={[{}, { numeric: true }]} />
    </Skeleton>,
  );
  const all = styles(root());
  const colors = all.flatMap((style) => Object.entries(style).filter(([key]) => key.endsWith('Color')).map(([, value]) => value));
  expect(new Set(colors)).toEqual(new Set([theme.color.raised, theme.color.line, theme.color.border]));
  expect(all.some((style) => (style.borderRadius ?? 0) !== 0)).toBe(false);
});
