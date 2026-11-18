import { useLayoutEffect, useRef, useState } from 'react';

import { theme } from '../../theme';
import type { ChartTip } from './barTips';

// The hover tooltip of the web charts (D21), shared by the chat's daily chart and the bar charts. It looks like the
// calendar's day tooltip (panel, 1px `line` border, mono first line, sans lines) and never covers the hovered day
// (owner request, 2026-11-17): it sits at the top of the chart's positioned box, beside the hovered span (a bar's whole
// slot, or a point), on the side `alignRight` prefers (left of it from the box's right half) or else the other; when it
// fits beside on neither side, it drops below the box, over the axis labels rather than the data. It is aria-hidden
// and takes no pointer, since the summary and "Show the numbers" carry every number. `useChartHover` follows a
// mouse or pen over an SVG, never a touch (a finger would hide the chart), and maps the pointer's x through the
// svg's own box to a 0 to 1 fraction, since the viewBox's aspect ratio is not preserved.

const C = theme.color;
const GAP = 8;

export function ChartTooltip(props: { tip: ChartTip; from: number; to: number; alignRight: boolean }): React.JSX.Element {
  const { tip, from, to, alignRight } = props;
  const ref = useRef<HTMLDivElement>(null);
  // The tooltip's own width and its chart box's, measured after each render, to pick the side it fits on.
  const [size, setSize] = useState({ tip: 0, box: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    const next = { tip: node?.offsetWidth ?? 0, box: node?.parentElement?.clientWidth ?? 0 };
    setSize((prev) => (prev.tip === next.tip && prev.box === next.box ? prev : next));
  }, [tip, from, to, alignRight]);
  const place = tipPlace(from, to, size.tip, size.box, alignRight);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="chart-tooltip"
      style={{
        position: 'absolute', left: place.left, top: place.below ? `calc(100% + ${String(GAP)}px)` : 0, zIndex: 2, pointerEvents: 'none',
        ...(place.flip ? { transform: 'translateX(-100%)' } : {}),
        width: 'max-content', maxWidth: 240, boxSizing: 'border-box', padding: '10px 12px', display: 'grid', gap: 4,
        background: C.panel, border: `1px solid ${C.line}`,
      }}
    >
      <span style={{ fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.white }}>{tip.title}</span>
      {tip.lines.map((line, index) => (
        <span key={index} style={{ fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px', color: C.text2 }}>{line}</span>
      ))}
    </div>
  );
}

/** Where the tooltip goes: its left edge (its right edge when `flip`), and whether it drops below the box. */
export interface TipPlace {
  left: number;
  flip: boolean;
  below: boolean;
}

/**
 * Places a tooltip `tip` wide in a box `box` wide so it never covers the hovered span `from` to `to` (box pixels):
 * GAP beside it on the preferred side when it fits there, else on the other, else centered under the box and kept
 * inside it. Unmeasured (a width of 0, as in jsdom) it sits beside on the preferred side, flipped by a transform.
 */
export function tipPlace(from: number, to: number, tip: number, box: number, alignRight: boolean): TipPlace {
  if (tip <= 0 || box <= 0) return alignRight ? { left: from - GAP, flip: true, below: false } : { left: to + GAP, flip: false, below: false };
  const leftFits = from - GAP - tip >= 0;
  const rightFits = to + GAP + tip <= box;
  if (leftFits && (alignRight || !rightFits)) return { left: from - GAP - tip, flip: false, below: false };
  if (rightFits) return { left: to + GAP, flip: false, below: false };
  return { left: Math.max(0, Math.min((from + to) / 2 - tip / 2, box - tip)), flip: false, below: true };
}

export interface ChartHover {
  /** The hovered point or bar, or null. */
  index: number | null;
  /** The svg's rendered width at the last pointer move, to turn a 0 to 1 position into pixels. */
  width: number;
}

/** What to spread onto the svg: its `ref` and the pointer handlers. */
export interface ChartBind {
  ref: (svg: SVGSVGElement | null) => void;
  onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
  onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
}

/** Follows a mouse or pen over the svg; `pick` turns the pointer's x fraction (0 to 1) into an index or null. */
export function useChartHover(pick: (fraction: number) => number | null): [ChartHover, ChartBind] {
  const [svg, ref] = useState<SVGSVGElement | null>(null);
  const [state, setState] = useState<ChartHover>({ index: null, width: 0 });
  // The same index and width answer with the same state, so a mouse moving within one bar re-renders nothing.
  const set = (index: number | null, width: number): void => {
    setState((prev) => (prev.index === index && prev.width === width ? prev : { index, width }));
  };
  const clear = (): void => { set(null, 0); };
  const follow = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.pointerType === 'touch') { clear(); return; }
    const box = svg?.getBoundingClientRect();
    if (box === undefined || box.width <= 0) { clear(); return; }
    set(pick((event.clientX - box.left) / box.width), box.width);
  };
  return [state, { ref, onPointerMove: follow, onPointerDown: follow, onPointerLeave: clear, onPointerCancel: clear }];
}
