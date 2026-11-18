import { theme } from '../../theme';
import { formatLoss, learningSummary } from './forecasts';
import type { LearningChartProps } from './LearningChart';

// A model run's learning curve (spec D50), inline SVG with no chart library, as the portal's other charts draw: the
// trees' loss after each boosting round, on the training days a solid `mint` line and on the validation days a dashed
// `white` line, so the two are told apart by shape as well as color, with a `line` rule at the round where the
// validation loss was lowest. The key, the rounds and the scale are printed. The SVG is aria-hidden: the words beside
// it (learningWords) carry the same numbers. The loss is a ratio, never a guest figure (D7).

const C = theme.color;
const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;
const HEIGHT = 160;
const WIDTH = 560;

/** The scale's top: the largest loss rounded up to the next 0.05, so the printed scale is a round number. */
export function lossTop(values: readonly number[]): number {
  return Math.max(0.05, Math.ceil((Math.max(...values) - 1e-9) / 0.05) * 0.05);
}

export function LearningChart(props: LearningChartProps): React.JSX.Element | null {
  const { learning } = props;
  const summary = learningSummary(learning);
  const { rounds } = summary;
  if (rounds === 0) return null;
  const train = learning.train.slice(0, rounds);
  const valid = learning.valid.slice(0, rounds);
  const top = lossTop([...train, ...valid]);
  const x = (index: number): number => (rounds === 1 ? WIDTH / 2 : (index / (rounds - 1)) * WIDTH);
  const y = (value: number): number => HEIGHT - 1 - (value / top) * (HEIGHT - 2);
  const points = (values: readonly number[]): string => values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const best = x(summary.bestRound - 1);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        style={{ width: '100%', height: HEIGHT, display: 'block' }}
      >
        <path d={`M0 0.5 H${String(WIDTH)} M0 ${String(HEIGHT - 0.5)} H${String(WIDTH)}`} stroke={C.border} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path data-mark="best" d={`M${best.toFixed(1)} 0 V${String(HEIGHT)}`} stroke={C.line} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <polyline data-series="train" points={points(train)} fill="none" stroke={C.mint} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <polyline data-series="valid" points={points(valid)} fill="none" stroke={C.white} strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between' }}>
        <span>Round 1</span>
        <span>{`Round ${String(rounds)}`}</span>
      </div>
      <p aria-hidden="true" style={{ ...mono, margin: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 0, borderTop: `2px solid ${C.mint}` }} />Training</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 0, borderTop: `2px dashed ${C.white}` }} />Validation</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 0, height: 12, borderLeft: `1px solid ${C.line}` }} />{`Lowest validation loss, round ${String(summary.bestRound)}`}</span>
      </p>
      <p style={{ ...mono, margin: 0 }}>{`Scale 0 to ${formatLoss(top)}. The loss is the mean absolute log error, so 0.100 is about 10% off.`}</p>
    </div>
  );
}
