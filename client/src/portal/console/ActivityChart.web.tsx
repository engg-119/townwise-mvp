import { useCallback, useEffect, useId, useState } from 'react';

import { theme } from '../../theme';
import { scaleTop } from '../analytics/AnalyticsCharts.web';
import { ChartTooltip, useChartHover } from '../analytics/ChartTooltip.web';
import { slotIndex } from '../analytics/hoverMath';
import { formatCount, formatDate, plural } from '../format';
import { useBreakpoint } from '../hooks';
import type { ActivityChartProps } from './ActivityChart';
import { chartBars, dayActions, GROUP_LABEL, type ChartBar } from './overview';
import { ACTION_GROUPS, type ActionGroup } from './schemas';

// The Overview's activity by day on web (P32, design decision 7), inline SVG with no chart library, as the analytics
// charts draw (AnalyticsCharts.web.tsx): two bands on one day axis, people who used the app each day as mint bars above,
// and the day's actions as bars stacked in the groups' order below, each band on its own round scale (`scaleTop`)
// printed at its left. Mint is the people's alone. The five groups differ by mark, not only by shade, so they tell
// apart in both palettes: uploads solid `white`, notes a diagonal hatch, TownwiseAI solid `line`, orders dots, team an
// outline; the hatch, the dots and the outline are drawn in `white`, and segments are kept apart by a 1px `ground`
// rule. The key draws each mark the same way. The SVG stretches its 300-unit width to the column, so the patterns are
// scaled back by the measured width to stay square. At 90 days under 480px a day would be a 2px bar, so each bar is
// a week counted back from the newest day (actions summed, people the most on one day), and a caption says so. A mouse
// or pen over a bar shows its counts (ChartTooltip.web.tsx). The SVG and its printed counts are aria-hidden: the
// summary line and the "Show each day" table carry the same numbers. Every color is an existing token.

const C = theme.color;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;

/** How each group is marked: a solid fill, a pattern (with an outline), or an outline alone. */
export const GROUP_MARK: Readonly<Record<ActionGroup, 'solid' | 'gray' | 'hatch' | 'dots' | 'outline'>> = {
  uploads: 'solid', notes: 'hatch', townwiseAi: 'gray', orders: 'dots', team: 'outline',
};

const WIDTH = 300;
const PEOPLE_HEIGHT = 64;
const BAND_GAP = 28;
const ACTIONS_HEIGHT = 112;
const HEIGHT = PEOPLE_HEIGHT + BAND_GAP + ACTIONS_HEIGHT;
const ACTIONS_TOP = PEOPLE_HEIGHT + BAND_GAP;
/** Room at the left for each band's scale. */
const GUTTER = 44;
/** Below this screen width, 90 days draw as weeks. */
const WEEKLY_BELOW = 480;

/** The patterns, `xScale` user units to a pixel across, so a hatch stays at 45 degrees and a dot stays round. */
function Patterns(props: { id: string; xScale: number }): React.JSX.Element {
  const transform = `scale(${String(props.xScale)} 1)`;
  return (
    <defs>
      <pattern id={`${props.id}-hatch`} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform={`${transform} rotate(45)`}>
        <rect x={0} y={0} width={1.5} height={4} fill={C.white} />
      </pattern>
      <pattern id={`${props.id}-dots`} width={4} height={4} patternUnits="userSpaceOnUse" patternTransform={transform}>
        <circle cx={2} cy={2} r={1} fill={C.white} />
      </pattern>
    </defs>
  );
}

/** A segment's fill and outline for its group's mark. */
function markProps(group: ActionGroup, id: string): { fill: string; stroke?: string } {
  switch (GROUP_MARK[group]) {
    case 'solid': return { fill: C.white };
    case 'gray': return { fill: C.line };
    case 'hatch': return { fill: `url(#${id}-hatch)`, stroke: C.white };
    case 'dots': return { fill: `url(#${id}-dots)`, stroke: C.white };
    case 'outline': return { fill: 'none', stroke: C.white };
  }
}

/** The svg's drawn width in pixels, once measured (none in tests, which lay nothing out). */
function useDrawnWidth(): [number | null, (node: SVGSVGElement | null) => void] {
  const [node, setNode] = useState<SVGSVGElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(next > 0 ? next : null);
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, [node]);
  return [width, setNode];
}

function tipOf(bar: ChartBar, weekly: boolean): { title: string; lines: string[] } {
  const groups = ACTION_GROUPS.filter((group) => bar.actions[group] > 0).map((group) => `${GROUP_LABEL[group]}: ${formatCount(bar.actions[group])}`);
  const people = weekly
    ? `Most people on one day: ${formatCount(bar.activePeople)}`
    : `${plural(bar.activePeople, 'person', 'people')} used the app`;
  return {
    title: weekly ? `${formatDate(bar.from)} to ${formatDate(bar.to)}` : formatDate(bar.from),
    lines: [people, `${plural(dayActions(bar), 'action', 'actions')} recorded`, ...groups],
  };
}

function Count(props: { value: number; top: number }): React.JSX.Element {
  return (
    <span aria-hidden="true" style={{ ...mono, position: 'absolute', left: -GUTTER, width: GUTTER - 8, textAlign: 'right', top: props.top, transform: 'translateY(-50%)' }}>
      {formatCount(props.value)}
    </span>
  );
}

/** The key's mark for a group, drawn as the bars draw it. */
function Swatch(props: { group: ActionGroup; id: string }): React.JSX.Element {
  const id = `${props.id}-key-${props.group}`;
  return (
    <span data-key={props.group} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <svg width={12} height={12} viewBox="0 0 12 12" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
        <Patterns id={id} xScale={1} />
        <rect data-mark={GROUP_MARK[props.group]} x={0.5} y={0.5} width={11} height={11} strokeWidth={1} {...markProps(props.group, id)} />
      </svg>
      {GROUP_LABEL[props.group]}
    </span>
  );
}

export function ActivityChart(props: ActivityChartProps): React.JSX.Element | null {
  const { width: screen } = useBreakpoint();
  const weekly = props.series.length > 30 && screen < WEEKLY_BELOW;
  const bars = chartBars(props.series, weekly);
  const n = bars.length;
  const [hover, bind] = useChartHover((fraction) => slotIndex(fraction, n));
  const [drawn, measure] = useDrawnWidth();
  const { ref: hoverRef } = bind;
  const ref = useCallback((node: SVGSVGElement | null) => { hoverRef(node); measure(node); }, [hoverRef, measure]);
  const id = `activity${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (n === 0) return null;
  const peopleTop = scaleTop(Math.max(0, ...bars.map((bar) => bar.activePeople)));
  const actionsTop = scaleTop(Math.max(0, ...bars.map(dayActions)));
  const slot = WIDTH / n;
  // Thin bars at 90 days: three quarters of the slot.
  const bar = Math.min(24, slot * (n > 30 ? 0.75 : 0.6));
  const x = (index: number): number => index * slot + (slot - bar) / 2;
  const actionsY = (value: number): number => ACTIONS_TOP + ACTIONS_HEIGHT - (value / actionsTop) * (ACTIONS_HEIGHT - 1);
  const hovered = hover.index === null ? undefined : bars[hover.index];
  const first = bars[0];
  const last = bars[n - 1];
  const rules = [
    `M0 0.5 H${String(WIDTH)}`, `M0 ${String(PEOPLE_HEIGHT - 0.5)} H${String(WIDTH)}`,
    `M0 ${String(ACTIONS_TOP + 0.5)} H${String(WIDTH)}`, `M0 ${String(HEIGHT - 0.5)} H${String(WIDTH)}`,
  ].join(' ');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span aria-hidden="true" style={{ ...mono, color: C.text2, marginLeft: GUTTER }}>{weekly ? 'Most people on one day of each week' : 'People who used the app each day'}</span>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: GUTTER }}>
        <svg {...bind} ref={ref} data-chart="activity" viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ width: '100%', height: HEIGHT, display: 'block' }}>
          <Patterns id={id} xScale={drawn === null ? 1 : WIDTH / drawn} />
          <path d={rules} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {hover.index === null ? null : <rect data-hover="day" x={hover.index * slot} y={0} width={slot} height={HEIGHT} fill={C.white} fillOpacity={0.1} />}
          {bars.map((each, index) => {
            const h = (each.activePeople / peopleTop) * (PEOPLE_HEIGHT - 1);
            return h <= 0 ? null : <rect key={each.to} data-band="people" x={x(index)} y={PEOPLE_HEIGHT - h} width={bar} height={h} fill={C.mint} />;
          })}
          {bars.map((each, index) => {
            let base = 0;
            const parts = ACTION_GROUPS.flatMap((group) => {
              const value = each.actions[group];
              if (value <= 0) return [];
              const bottom = actionsY(base);
              base += value;
              const top = actionsY(base);
              return [{ group, top, height: bottom - top }];
            });
            if (parts.length === 0) return null;
            return (
              <g key={each.to} {...(weekly ? { 'data-week': each.from } : { 'data-day': each.from })}>
                {parts.map((part) => (
                  <rect
                    key={part.group}
                    data-group={part.group}
                    data-mark={GROUP_MARK[part.group]}
                    x={x(index)}
                    y={part.top}
                    width={bar}
                    height={part.height}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    {...markProps(part.group, id)}
                  />
                ))}
                {parts.slice(1).map((part) => (
                  <path key={`${part.group}-rule`} d={`M${x(index).toFixed(2)} ${(part.top + part.height).toFixed(2)} h${bar.toFixed(2)}`} stroke={C.ground} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            );
          })}
        </svg>
        <span aria-hidden="true" style={{ ...mono, color: C.text2, position: 'absolute', left: 0, top: PEOPLE_HEIGHT + 6, pointerEvents: 'none' }}>Actions recorded</span>
        <Count value={peopleTop} top={0.5} />
        <Count value={0} top={PEOPLE_HEIGHT - 0.5} />
        <Count value={actionsTop} top={ACTIONS_TOP + 0.5} />
        <Count value={0} top={HEIGHT - 0.5} />
        {hovered === undefined || hover.index === null ? null : (
          <ChartTooltip tip={tipOf(hovered, weekly)} from={(hover.index / n) * hover.width} to={((hover.index + 1) / n) * hover.width} alignRight={hover.index + 0.5 > n / 2} />
        )}
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', marginLeft: GUTTER }}>
        <span>{first === undefined ? '' : formatDate(first.from)}</span>
        <span>{last === undefined ? '' : formatDate(last.to)}</span>
      </div>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {ACTION_GROUPS.map((group) => <Swatch key={group} group={group} id={id} />)}
      </div>
      {weekly ? (
        <p aria-hidden="true" style={{ ...mono, margin: 0 }}>
          Each bar is a week, counted back from the newest day: the week’s actions, and the most people on one of its days.
        </p>
      ) : null}
    </div>
  );
}
