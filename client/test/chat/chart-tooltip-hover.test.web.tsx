import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ChartTooltip, useChartHover } from '../../src/portal/analytics/ChartTooltip.web';

// The chart tooltip: no re-render while the hovered index and width stay the same, and it stays inside its box.

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

function tooltip(x: number, alignRight: boolean): HTMLElement {
  render(<div data-box="1"><ChartTooltip tip={{ title: 'Sat', lines: ['90 guests'] }} x={x} alignRight={alignRight} /></div>);
  return screen.getByTestId('chart-tooltip');
}

test('on a narrow chart a flipped tooltip is kept inside the left edge', () => {
  widths(200, 240);
  expect(tooltip(150, true).style.left).toBe('0px');
});

test('a tooltip that would pass the right edge is pulled back', () => {
  widths(200, 240);
  expect(tooltip(200, false).style.left).toBe('40px');
});

test('a tooltip that fits sits beside the hovered x as before', () => {
  widths(100, 600);
  expect(tooltip(300, true).style.left).toBe('192px');
  cleanup();
  expect(tooltip(300, false).style.left).toBe('308px');
});
