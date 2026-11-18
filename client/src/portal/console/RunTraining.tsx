import { useCallback } from 'react';

import { formatDate, plural } from '../format';
import { useLoad } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Button } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { Panel, Stack } from '../ui/layout';
import { Heading, Mono, Small } from '../ui/text';
import { fetchRunTraining, learningWords, type RunTraining as Training, type StaffRun } from './forecasts';
import { LearningChart } from './LearningChart';
import type { StaffOrg } from './schemas';

// How one forecast run was trained (P21 Forecasts, spec D50), opened from the run's model name: the code and the days
// it learned from, its method and settings, its backtest and each half-year fold, and for a model run the forecast lab
// made, the trees' loss on training and validation days after each boosting round. Percentages, counts, dates,
// settings and loss ratios only, never a guest figure (D7). An imported run shows what its file held and says the
// rest wasn't recorded.

function pct(value: number): string {
  return `${String(value)}%`;
}

function Fact(props: { label: string; value: string }): React.JSX.Element {
  return <Small><Mono tone="text3">{`${props.label}  `}</Mono>{props.value}</Small>;
}

function methodLines(training: Training, run: StaffRun): string[] {
  const { method } = training;
  if (method === null) {
    return run.trainingSource === 'townwise_lab'
      ? ['Its settings can’t be read.']
      : ['Trained in the team’s notebook from files the owner sent. Its settings and learning curve weren’t recorded with the import.'];
  }
  if (method.kind === 'baseline') {
    return [
      `A seasonal baseline: a rule, with nothing fitted round by round. Its level is the last ${plural(method.levelDays, 'day', 'days')} of sales (at least ${String(method.levelMinDays)}), shaped by last year’s weeks and the town calendar.`,
    ];
  }
  const { trees } = method;
  return [
    'Three linear quantile baselines (10th, 50th and 90th percentile), times one XGBoost multiplier fitted to what the median baseline missed.',
    `Baseline inputs: ${method.baseInputs.join(', ')}.`,
    `Tree inputs: ${method.eventInputs.join(', ')}.`,
    `Trees: ${plural(trees.rounds, 'round', 'rounds')}, learning rate ${String(trees.learningRate)}, depth ${String(trees.maxDepth)}, min child weight ${String(trees.minChildWeight)}, row sample ${String(trees.subsample)}, column sample ${String(trees.columnSample)}, L2 ${String(trees.l2)}, objective ${trees.objective}.`,
    `Backtests refit every ${plural(method.refitEveryMonths, 'month', 'months')}.`,
  ];
}

function Details(props: { training: Training; run: StaffRun }): React.JSX.Element {
  const { training, run } = props;
  const { validation, backtest, learning, history } = training;
  const regime = training.method?.regimeStart ?? null;
  return (
    <Stack gap={20}>
      <Stack gap={4}>
        <Fact label="Days" value={`${formatDate(history.from)} to ${formatDate(history.to)}${history.days === null ? '' : `, ${plural(history.days, 'day', 'days')} with guests`}`} />
        <Fact label="Code" value={training.code.commit} />
        {training.code.imageDigest === null ? null : <Fact label="Image" value={training.code.imageDigest} />}
        {regime === null ? null : <Fact label="Pattern change" value={formatDate(regime)} />}
      </Stack>
      <Stack gap={4}>
        <Heading level={3}>Method</Heading>
        {methodLines(training, run).map((line) => <Small key={line}>{line}</Small>)}
      </Stack>
      <Stack gap={8}>
        <Heading level={3}>Backtest</Heading>
        {validation === null && backtest === null ? <Small>No backtest was recorded for this run.</Small> : null}
        {validation === null && backtest !== null ? (
          <Small>{`${plural(backtest.weeks, 'week', 'weeks')} from ${formatDate(backtest.from)} to ${formatDate(backtest.to)}: a typical week ${pct(backtest.weeklyTypicalErrorPct)} off, ${plural(backtest.weeksOver20Pct, 'week', 'weeks')} more than 20% off.`}</Small>
        ) : null}
        {validation === null ? null : (
          <>
            <Small>{`${plural(validation.weeks, 'week', 'weeks')} from ${formatDate(validation.from)} to ${formatDate(validation.to)}, each forecast at least 28 days ahead: weekly error ${pct(validation.weeklyWapePct)}, daily error ${pct(validation.dailyWapePct)}, worst week ${pct(validation.worstWeekPct)}, ${plural(validation.weeksOver20, 'week', 'weeks')} more than 20% off, ${String(validation.coverage.inside)} of ${plural(validation.coverage.weeks, 'week', 'weeks')} inside the 80% range.`}</Small>
            <Small>{`The same weeks by each weekday’s median: ${pct(validation.weekdayMedianWeeklyWapePct)}.${validation.engines === null ? '' : ` Model ${validation.engines.modelWeeklyWapePct === null ? 'did not run' : pct(validation.engines.modelWeeklyWapePct)}, seasonal baseline ${pct(validation.engines.baselineWeeklyWapePct)}.`}`}</Small>
            {validation.folds.length === 0 ? null : (
              <DataTable
                label="Half-year folds"
                columns={[
                  { key: 'train', label: 'Trained through' },
                  { key: 'test', label: 'Tested on', flex: 1.6 },
                  { key: 'weeks', label: 'Weeks', numeric: true },
                  { key: 'error', label: 'Weekly error', numeric: true },
                  { key: 'over', label: 'Over 20% off', numeric: true },
                ]}
                rows={validation.folds.map((fold) => ({
                  key: fold.from,
                  cells: {
                    train: formatDate(fold.trainThrough),
                    test: `${formatDate(fold.from)} to ${formatDate(fold.to)}`,
                    weeks: String(fold.weeks),
                    error: pct(fold.weeklyWapePct),
                    over: String(fold.weeksOver20),
                  },
                }))}
              />
            )}
          </>
        )}
      </Stack>
      <Stack gap={8}>
        <Heading level={3}>Training and validation loss</Heading>
        {learning === null ? (
          <Small>
            {training.method?.kind === 'baseline'
              ? 'A seasonal baseline has no rounds, so it has no loss curve.'
              : 'No loss curve was recorded for this run. The forecast lab records one for each model it trains from now on.'}
          </Small>
        ) : (
          <>
            {learningWords(learning).map((line) => <Small key={line}>{line}</Small>)}
            <LearningChart learning={learning} />
          </>
        )}
      </Stack>
    </Stack>
  );
}

export function RunTraining(props: { org: StaffOrg; run: StaffRun; onClose: () => void }): React.JSX.Element {
  const { org, run } = props;
  const { api } = usePortal();
  const { state, reload } = useLoad(useCallback(() => fetchRunTraining(api, org.id, run.id), [api, org.id, run.id]));
  const title = `How ${run.model.label} was trained`;
  return (
    <Panel label={title}>
      <Stack gap={16} style={{ alignItems: 'stretch' }}>
        <Heading level={3}>{title}</Heading>
        <Small>{`Forecast for ${formatDate(run.range.from)} to ${formatDate(run.range.to)}, made ${formatDate(run.madeAt)}.`}</Small>
        {state.status === 'loading' ? <LoadingLine text="Loading training details…" /> : null}
        {state.status === 'failed' ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {state.status === 'ready' ? <Details training={state.data} run={run} /> : null}
        <Button variant="link" label="Close" accessibilityLabel={`Close ${title}`} onPress={props.onClose} />
      </Stack>
    </Panel>
  );
}
