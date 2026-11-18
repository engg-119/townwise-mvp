import { anchorBeside, anchorOf } from '../../../src/portal/calendar/DayTooltip.web';

// The day tooltip's anchors never put it over the hovered day (owner request, 2026-11-17): anchorOf at a cell's
// corner, below or above it; anchorBeside past a week column's side, level with its top.

function box(left: number, top: number, width: number, height: number): Element {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  return element;
}

const FRAME = box(100, 50, 700, 600);

test('beside a column in the week’s left half: past its right edge, level with its top', () => {
  // Column 2 of 7 (100px each, from x 200): its right edge is 300, so 304 in the frame's coordinates is 204.
  expect(anchorBeside(box(200, 50, 100, 600), FRAME)).toEqual({ x: 204, y: -4, alignRight: false, above: false });
});

test('beside a column in the week’s right half: before its left edge, ending there', () => {
  expect(anchorBeside(box(600, 50, 100, 600), FRAME)).toEqual({ x: 496, y: -4, alignRight: true, above: false });
});

test('anchorOf stays at a cell’s corner, below it in the upper rows and above it in the lower', () => {
  expect(anchorOf(box(200, 60, 100, 80), FRAME)).toEqual({ x: 100, y: 90, alignRight: false, above: false });
  expect(anchorOf(box(600, 500, 100, 80), FRAME)).toEqual({ x: 600, y: 450, alignRight: true, above: true });
});
