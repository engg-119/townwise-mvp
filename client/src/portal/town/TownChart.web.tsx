import { useState } from 'react';

import { fmt1, fmtSigned, side } from '../../marketing/format';
import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { DATA_YEAR, MONTHS, northeastSeries, type MeasuredProfile } from '../towns';
import { MonthScrubber } from './MonthScrubber.web';

// The town's 2025 food-service employment curve against the Northeast, with the monthly gap as bars (the design
// system's DeltaChart, as on the homepage panel and the Waiting board), and its MonthScrubber. Inline SVG,
// aria-hidden: the text summary and “Show the numbers” carry the data. The county is mint and solid, the Northeast
// dashed, the scale fitted to the town. The scrubber picks a month, starting at the viewer's current calendar month:
// a white cursor marks it on the chart, and the readout above prints its gap and both index values, as the homepage panel
// does. Nothing animates. Path coordinates round to 0.01 and are never printed.

const C = theme.color;
const X0 = 12;
const X1 = 288;
const TOP = 8;
const BOTTOM = 128;
const ZERO = 172;
const HALF = 22;
const HEIGHT = 196;

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

function x(month: number): number {
  return X0 + (month * (X1 - X0)) / 11;
}

function line(values: readonly number[], y: (value: number) => number): string {
  return values.map((value, month) => `${month === 0 ? 'M' : 'L'}${String(r2(x(month)))} ${String(r2(y(value)))}`).join(' ');
}

export function TownChart(props: { profile: MeasuredProfile }): React.JSX.Element {
  const { series, county } = props.profile;
  const { phone } = useBreakpoint();
  const [chosen, setChosen] = useState(() => new Date().getMonth());
  const chosenGap = series.gap[chosen] ?? 0;
  const [lo, hi] = series.domain;
  const y = (value: number): number => TOP + ((hi - value) / (hi - lo)) * (BOTTOM - TOP);
  const most = Math.max(...series.gap.map((gap) => Math.abs(gap)));
  const bar = (gap: number, month: number): string => {
    const h = most === 0 ? 0 : (Math.abs(gap) / most) * HALF;
    const [a, b] = [r2(x(month) - 6), r2(x(month) + 6)];
    return gap >= 0
      ? `M${String(a)} ${String(r2(ZERO - h))} H${String(b)} V${String(ZERO)} H${String(a)} Z`
      : `M${String(a)} ${String(ZERO)} H${String(b)} V${String(r2(ZERO + h))} H${String(a)} Z`;
  };
  const ticks = [
    { label: String(hi), y: y(hi) }, { label: '100', y: y(100) }, { label: String(lo), y: y(lo) },
    { label: fmtSigned(most), y: ZERO - HALF }, { label: fmtSigned(-most), y: ZERO + HALF },
  ];
  const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;
  const big = phone ? 40 : 56;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div aria-live="polite" style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        <p style={{ ...mono, fontWeight: 500, fontSize: big, lineHeight: `${String(big)}px`, letterSpacing: '-.02em', color: C.mint, margin: 0 }}>
          {fmtSigned(chosenGap)}
        </p>
        <p style={{ ...mono, margin: 0 }}>{`${side(chosenGap)} the Northeast, index points, ${MONTHS[chosen] ?? ''} ${String(DATA_YEAR)}`}</p>
        <p style={{ ...mono, color: C.text2, margin: 0 }}>
          {`${county} ${fmt1(series.index[chosen] ?? 0)} · Northeast ${fmt1(northeastSeries.index[chosen] ?? 0)}`}
        </p>
      </div>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 16, borderTop: `2px solid ${C.seriesCounty}` }} />{county}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 16, borderTop: `2px dashed ${C.seriesNortheast}` }} />Northeast
        </span>
      </div>
      <div style={{ position: 'relative', height: HEIGHT, marginLeft: 44 }}>
        <svg
          viewBox={`0 0 300 ${String(HEIGHT)}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', overflow: 'visible' }}
        >
          <path d={[hi, 100, lo].map((value) => `M0 ${String(r2(y(value)))} H300`).join(' ')} fill="none" stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={`M0 ${String(ZERO)} H300`} fill="none" stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={series.gap.flatMap((gap, month) => (gap >= 0 ? [bar(gap, month)] : [])).join(' ')} fill={C.mint} />
          <path
            d={series.gap.flatMap((gap, month) => (gap < 0 ? [bar(gap, month)] : [])).join(' ')}
            fill="none" stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke"
          />
          <path d={line(northeastSeries.index, y)} fill="none" stroke={C.seriesNortheast} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          <path d={line(series.index, y)} fill="none" stroke={C.seriesCounty} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={`M${String(r2(x(chosen)))} 0 V${String(HEIGHT)}`} fill="none" stroke={C.white} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {ticks.map((tick) => (
          <span
            key={tick.label + String(tick.y)}
            aria-hidden="true"
            style={{ ...mono, position: 'absolute', left: -44, width: 38, textAlign: 'right', transform: 'translateY(-50%)', top: `${String(r2((tick.y / HEIGHT) * 100))}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', marginLeft: 44 }}>
        <span>{MONTHS[0]}</span><span>{DATA_YEAR}</span><span>{MONTHS[11]}</span>
      </div>
      <p style={{ ...mono, margin: 0 }}>Scale fitted to this town. Index: 100 = an average month</p>
      <MonthScrubber month={chosen} onMonth={setChosen} />
    </div>
  );
}
