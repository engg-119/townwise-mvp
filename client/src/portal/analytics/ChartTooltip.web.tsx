import { useLayoutEffect, useRef, useState } from 'react';

import { theme } from '../../theme';
import type { ChartTip } from './barTips';

// The hover tooltip of the web charts (D21), shared by the chat's daily chart and the bar charts. It looks like the
// calendar's day tooltip (panel, 1px `line` border, mono first line, sans lines) and sits at the top of the chart's
// positioned box, beside the hovered x: left of it from the box's right half, so it stays inside. It is aria-hidden
// and takes no pointer, since the summary and "Show the numbers" carry every number. `useChartHover` follows a
// mouse or pen over an SVG, never a touch (a finger would hide the chart), and maps the pointer's x through the
// svg's own box to a 0 to 1 fraction, since the viewBox's aspect ratio is not preserved.

const C = theme.color;
const GAP = 8;

export function ChartTooltip(props: { tip: ChartTip; x: number; alignRight: boolean }): React.JSX.Element {
  const { tip, x, alignRight } = props;
  const ref = useRef<HTMLDivElement>(null);
  // The tooltip's own width and its chart box's, measured after each render, so a narrow box can't push it out
  // (the flip alone leaves it hanging off the left edge when the hovered x is under one tooltip's width).
  const [size, setSize] = useState({ tip: 0, box: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    const next = { tip: node?.offsetWidth ?? 0, box: node?.parentElement?.clientWidth ?? 0 };
    setSize((prev) => (prev.tip === next.tip && prev.box === next.box ? prev : next));
  }, [tip, x, alignRight]);
  let left = x + (alignRight ? -GAP : GAP);
  let transform: string | undefined = alignRight ? 'translateX(-100%)' : undefined;
  if (size.tip > 0 && size.box > 0) {
    // Placed by its left edge, kept inside 0 to the box's width (or at 0 when it is wider than the box).
    const edge = alignRight ? x - GAP - size.tip : x + GAP;
    left = Math.max(0, Math.min(edge, size.box - size.tip));
    transform = undefined;
  }
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="chart-tooltip"
      style={{
        position: 'absolute', left, top: 0, zIndex: 2, pointerEvents: 'none',
        ...(transform === undefined ? {} : { transform }),
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
