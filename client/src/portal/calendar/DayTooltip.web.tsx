import { theme } from '../../theme';
import type { TooltipLines } from './model';

// A day's hover tooltip on web (spec 16.3 P27 and P11): the date, then its lines (the figure and range, the
// notes' guests, the top three reasons in short words, “Saturday: usually more guests”; model.ts tooltipLines). It
// sits beside the cell a mouse or pen rests on, inside the grid's
// positioned box, and turns to stay inside it: from the grid's right half it ends at the cell's right edge, and from
// its lower rows it sits above the cell. It is aria-hidden, since the cell's label and the day panel say the same
// words, and it takes no pointer. Home's month grid (MonthGrid.web.tsx) uses it too.

const C = theme.color;

/** Where the tooltip goes, in the grid box's coordinates. */
export interface TooltipAnchor {
  /** The cell's left edge, or its right edge when `alignRight`. */
  x: number;
  /** The cell's bottom edge, or its top edge when `above`. */
  y: number;
  alignRight: boolean;
  above: boolean;
}

/** The anchor for `cell` inside `box` (the tooltip's positioned parent). */
export function anchorOf(cell: Element, box: Element): TooltipAnchor {
  const at = cell.getBoundingClientRect();
  const frame = box.getBoundingClientRect();
  const alignRight = at.left + at.width / 2 > frame.left + frame.width / 2;
  const above = at.top + at.height / 2 > frame.top + frame.height * 0.6;
  return {
    x: (alignRight ? at.right : at.left) - frame.left,
    y: (above ? at.top : at.bottom) - frame.top,
    alignRight,
    above,
  };
}

const GAP = 4;

export function DayTooltip(props: { tip: TooltipLines; anchor: TooltipAnchor }): React.JSX.Element {
  const { tip, anchor } = props;
  return (
    <div
      aria-hidden="true"
      data-testid="calendar-tooltip"
      style={{
        position: 'absolute', left: anchor.x, top: anchor.y + (anchor.above ? -GAP : GAP), zIndex: 2, pointerEvents: 'none',
        transform: `translate(${anchor.alignRight ? '-100%' : '0'}, ${anchor.above ? '-100%' : '0'})`,
        width: 'max-content', maxWidth: 280, boxSizing: 'border-box', padding: '10px 12px', display: 'grid', gap: 4,
        background: C.panel, border: `1px solid ${C.line}`,
      }}
    >
      <span style={{ fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.white }}>{tip.date}</span>
      {tip.lines.map((line, index) => (
        <span key={index} style={{ fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px', color: C.text2 }}>{line}</span>
      ))}
    </div>
  );
}
