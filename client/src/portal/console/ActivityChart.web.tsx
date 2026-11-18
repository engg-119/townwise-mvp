import { theme } from '../../theme';
import { scaleTop } from '../analytics/AnalyticsCharts.web';
import { ChartTooltip, useChartHover } from '../analytics/ChartTooltip.web';
import { slotIndex } from '../analytics/hoverMath';
import { formatCount, formatDate, plural } from '../format';
import type { ActivityChartProps } from './ActivityChart';
import { dayActions, GROUP_LABEL } from './overview';
import { ACTION_GROUPS, type ActionGroup, type OverviewDay } from './schemas';

// The Overview's activity by day on web (P32, design decision 7), inline SVG with no chart library, as the analytics
// charts draw (AnalyticsCharts.web.tsx): two bands on one day axis, people active each day as mint bars above, and the
// day's actions as bars stacked in the groups' order below, each band on its own round scale (`scaleTop`) printed at
// its left. Segments are kept apart by a 1px `ground` rule, so a group is told by its place and the key as well as
// its fill. A mouse or pen over a day shows its counts (ChartTooltip.web.tsx). The SVG and its printed counts are
// aria-hidden: the summary line and the "Show each day" table carry the same numbers. The fills are existing tokens.

const C = theme.color;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;

/** Each group's fill, mint first, ordered so neighbors in a stack differ most in lightness in both palettes. */
export const GROUP_FILL: Readonly<Record<ActionGroup, string>> = {
  uploads: C.mint, notes: C.line, townwiseAi: C.white, orders: C.text3, team: C.text2,
};

const WIDTH = 300;
const PEOPLE_HEIGHT = 64;
const BAND_GAP = 28;
const ACTIONS_HEIGHT = 112;
const HEIGHT = PEOPLE_HEIGHT + BAND_GAP + ACTIONS_HEIGHT;
const ACTIONS_TOP = PEOPLE_HEIGHT + BAND_GAP;
/** Room at the left for each band's scale. */
const GUTTER = 44;

function tipOf(day: OverviewDay): { title: string; lines: string[] } {
  const groups = ACTION_GROUPS.filter((group) => day.actions[group] > 0).map((group) => `${GROUP_LABEL[group]}: ${formatCount(day.actions[group])}`);
  return {
    title: formatDate(day.day),
    lines: [plural(day.activePeople, 'person active', 'people active'), `${plural(dayActions(day), 'action', 'actions')} recorded`, ...groups],
  };
}

function Count(props: { value: number; top: number }): React.JSX.Element {
  return (
    <span aria-hidden="true" style={{ ...mono, position: 'absolute', left: -GUTTER, width: GUTTER - 8, textAlign: 'right', top: props.top, transform: 'translateY(-50%)' }}>
      {formatCount(props.value)}
    </span>
  );
}

function Swatch(props: { color: string; label: string }): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-block', width: 10, height: 10, background: props.color }} />
      {props.label}
    </span>
  );
}

export function ActivityChart(props: ActivityChartProps): React.JSX.Element | null {
  const { series } = props;
  const n = series.length;
  const [hover, bind] = useChartHover((fraction) => slotIndex(fraction, n));
  if (n === 0) return null;
  const peopleTop = scaleTop(Math.max(0, ...series.map((day) => day.activePeople)));
  const actionsTop = scaleTop(Math.max(0, ...series.map(dayActions)));
  const slot = WIDTH / n;
  // Thin bars at 90 days: three quarters of the slot, so they keep about 2px at 320px.
  const bar = Math.min(24, slot * (n > 30 ? 0.75 : 0.6));
  const x = (index: number): number => index * slot + (slot - bar) / 2;
  const actionsY = (value: number): number => ACTIONS_TOP + ACTIONS_HEIGHT - (value / actionsTop) * (ACTIONS_HEIGHT - 1);
  const hovered = hover.index === null ? undefined : series[hover.index];
  const first = series[0];
  const last = series[n - 1];
  const rules = [
    `M0 0.5 H${String(WIDTH)}`, `M0 ${String(PEOPLE_HEIGHT - 0.5)} H${String(WIDTH)}`,
    `M0 ${String(ACTIONS_TOP + 0.5)} H${String(WIDTH)}`, `M0 ${String(HEIGHT - 0.5)} H${String(WIDTH)}`,
  ].join(' ');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <span aria-hidden="true" style={{ ...mono, color: C.text2, marginLeft: GUTTER }}>People active</span>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: GUTTER }}>
        <svg {...bind} data-chart="activity" viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" style={{ width: '100%', height: HEIGHT, display: 'block' }}>
          <path d={rules} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {hover.index === null ? null : <rect data-hover="day" x={hover.index * slot} y={0} width={slot} height={HEIGHT} fill={C.white} fillOpacity={0.1} />}
          {series.map((day, index) => {
            const h = (day.activePeople / peopleTop) * (PEOPLE_HEIGHT - 1);
            return h <= 0 ? null : <rect key={day.day} data-band="people" x={x(index)} y={PEOPLE_HEIGHT - h} width={bar} height={h} fill={C.mint} />;
          })}
          {series.map((day, index) => {
            let base = 0;
            const parts = ACTION_GROUPS.flatMap((group) => {
              const value = day.actions[group];
              if (value <= 0) return [];
              const bottom = actionsY(base);
              base += value;
              const top = actionsY(base);
              return [{ group, top, height: bottom - top }];
            });
            if (parts.length === 0) return null;
            return (
              <g key={day.day} data-day={day.day}>
                {parts.map((part) => <rect key={part.group} data-group={part.group} x={x(index)} y={part.top} width={bar} height={part.height} fill={GROUP_FILL[part.group]} />)}
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
          <ChartTooltip tip={tipOf(hovered)} x={((hover.index + 0.5) / n) * hover.width} alignRight={hover.index + 0.5 > n / 2} />
        )}
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', marginLeft: GUTTER }}>
        <span>{first === undefined ? '' : formatDate(first.day)}</span>
        <span>{last === undefined ? '' : formatDate(last.day)}</span>
      </div>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {ACTION_GROUPS.map((group) => <Swatch key={group} color={GROUP_FILL[group]} label={GROUP_LABEL[group]} />)}
      </div>
      <p aria-hidden="true" style={{ ...mono, margin: 0 }}>{`People scale 0 to ${formatCount(peopleTop)}, actions scale 0 to ${formatCount(actionsTop)}. Days are UTC.`}</p>
    </div>
  );
}
