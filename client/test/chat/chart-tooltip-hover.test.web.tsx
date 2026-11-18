import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ChartTooltip, tipPlace, useChartHover } from '../../src/portal/analytics/ChartTooltip.web';

// The chart tooltip: no re-render while the hovered index and width stay the same, and it never covers the hovered
// span (owner request, 2026-11-17): beside it on whichever side fits, else under the chart box.

afterEach(cleanup);

function pointer(target: Element, type: string, clientX: number): void {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  fireEvent(target, event);
}

test('a pointer moving inside one slot does not re-render the chart', () => {
  let renders = 0;
  function Chart(): React.JSX.Element {
    const [, bind] = useChartHover((fraction) => Math.floor(fraction * 4));
    renders += 1;
    return <svg data-testid="svg" {...bind} />;
  }
  render(<Chart />);
  const svg = screen.getByTestId('svg');
  svg.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 100, right: 400, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  act(() => { pointer(svg, 'pointermove', 10); });
  // React may render once more before it settles on the unchanged state.
  act(() => { pointer(svg, 'pointermove', 15); });
  const after = renders;
  act(() => { pointer(svg, 'pointermove', 20); });
  act(() => { pointer(svg, 'pointermove', 90); });
  expect(renders).toBe(after);
  act(() => { pointer(svg, 'pointermove', 150); });
  expect(renders).toBe(after + 1);
});

function widths(tip: number, box: number): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return (this as HTMLElement).getAttribute('data-testid') === 'chart-tooltip' ? tip : 0; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).getAttribute('data-box') === '1' ? box : 0; } });
}

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

afterEach(() => {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
});

function tooltip(from: number, to: number, alignRight: boolean): HTMLElement {
  render(<div data-box="1"><ChartTooltip tip={{ title: 'Sat', lines: ['90 guests'] }} from={from} to={to} alignRight={alignRight} /></div>);
  return screen.getByTestId('chart-tooltip');
}

test('a tooltip that fits sits 8px beside the hovered slot, on the side alignRight prefers', () => {
  widths(100, 600);
  expect(tooltip(280, 320, true).style.left).toBe('172px');
  cleanup();
  const right = tooltip(280, 320, false);
  expect(right.style.left).toBe('328px');
  expect(right.style.top).toBe('0px');
});

test('when the preferred side has no room, the tooltip takes the other side rather than slide over the slot', () => {
  widths(200, 600);
  expect(tooltip(150, 190, true).style.left).toBe('198px');
  cleanup();
  expect(tooltip(420, 460, false).style.left).toBe('212px');
});

test('with room on neither side, the tooltip drops under the chart box, kept inside it', () => {
  widths(200, 240);
  const tip = tooltip(100, 140, true);
  expect(tip.style.top).toBe('calc(100% + 8px)');
  expect(tip.style.left).toBe('20px');
});

test('wherever the hovered span is, the tooltip never overlaps it', () => {
  for (const [tip, box, slot] of [[200, 240, 34], [240, 700, 100], [160, 300, 2]] as const) {
    for (let from = 0; from + slot <= box; from += 1) {
      for (const alignRight of [true, false]) {
        const place = tipPlace(from, from + slot, tip, box, alignRight);
        const clear = place.below || place.left + tip <= from || place.left >= from + slot;
        expect({ from, alignRight, clear, inside: place.left >= 0 && place.left + tip <= box }).toEqual({ from, alignRight, clear: true, inside: true });
      }
    }
  }
});

test('unmeasured (jsdom), it sits beside the preferred side as before, flipped by a transform', () => {
  const left = tooltip(300, 340, true);
  expect(left.style.left).toBe('292px');
  expect(left.style.transform).toBe('translateX(-100%)');
  cleanup();
  expect(tooltip(300, 340, false).style.left).toBe('348px');
});
