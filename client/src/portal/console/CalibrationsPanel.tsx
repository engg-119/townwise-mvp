import { useCallback, useState } from 'react';

import { hasCode } from '../errors';
import { formatDate } from '../format';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Button } from '../ui/Button';
import { Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { startCalibration, type Calibration } from './calibrations';
import { Dialog } from './Dialog';
import { RowActions } from './parts';
import { problemOf } from './problems';
import type { OrgLocation, StaffOrg } from './schemas';

// The Calibrations part of P21's Forecasts (forecast lab design call 8): a Calibrate button per location and the
// organization's newest calibrations with status, who started them, the gate's words and a summary of percentages
// and counts only (D7: staff see no guest figure outside view-as). A calibration's draft run is listed with the
// others above and withdrawn with the same Withdraw.

const ACTIVITY = 'Its admins see this in their Townwise staff activity.';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_WORDS: Readonly<Record<Calibration['status'], string>> = {
  queued: 'Waiting to start', running: 'Running', succeeded: 'Done', failed: 'Failed',
};

// The server’s own words for each refusal of a start (START_REFUSAL_WORDS in api/src/lab/service.ts), by its code: the
// client’s errors carry the code, not the text. calibrations.test.web.tsx pins each line to the server’s file.
export const REFUSALS: readonly (readonly [number, string, string])[] = [
  [503, 'lab_unavailable', 'Calibration isn’t available right now.'],
  [409, 'not_enough_history', 'Calibration needs at least 420 days from the first to the last day of sales history.'],
  [400, 'invalid_regime_start', 'The pattern change date must fall inside the sales history, at least 8 weeks before its last day.'],
  [409, 'chat_budget_exhausted', 'This month’s TownwiseAI budget is used up, so a calibration can’t start until it resets.'],
  [409, 'calibration_in_progress', 'A calibration for this location is already running.'],
  [429, 'calibrations_rate_limited', 'This organization has started 4 calibrations in the last day. Try again tomorrow.'],
  [503, 'lab_start_failed', 'The calibration couldn’t start. Try again in a few minutes.'],
];

function refusal(error: unknown): string | null {
  return REFUSALS.find(([status, code]) => hasCode(error, status, code))?.[2] ?? null;
}

/** "Weekly error 8.4% vs 10.1% for the current forecast, on 12 held-out weeks." and the lines under it. */
export function summaryLines(summary: NonNullable<Calibration['summary']>): string[] {
  const weeks = `${String(summary.weeks)} held-out weeks`;
  const first = summary.championWeeklyWapePct === null
    ? `Weekly error ${String(summary.weeklyWapePct)}% on ${weeks}.`
    : `Weekly error ${String(summary.weeklyWapePct)}% vs ${String(summary.championWeeklyWapePct)}% for the current forecast, on ${weeks}.`;
  return [
    first,
    `80% range held ${String(summary.coverage.inside)} of ${String(summary.coverage.weeks)} weeks.`,
    `Weekday bias ${String(summary.weekdayBiasPct)}%.`,
  ];
}

function CalibrateDialog(props: {
  org: StaffOrg; location: OrgLocation; onDone: () => Promise<void>; onClose: () => void;
}): React.JSX.Element {
  const { org, location, onDone } = props;
  const { api } = usePortal();
  const [regime, setRegime] = useState('');
  const text = regime.trim();
  const malformed = text !== '' && !DATE.test(text);
  const act = useAction(useCallback(async () => {
    await startCalibration(api, org.id, location.id, text === '' ? null : text);
    await onDone();
  }, [api, org.id, location.id, text, onDone]));
  return (
    <Dialog
      title={`Calibrate ${location.name}?`}
      body={`Townwise refits ${location.name}’s forecast on its sales history and notes, on Townwise’s servers, and scores it on held-out weeks. It costs $0.10 of ${org.name}’s TownwiseAI budget. If it passes every check and forecasts are on, it publishes itself. ${ACTIVITY}`}
      confirmLabel="Calibrate"
      pendingLabel="Starting…"
      pending={act.pending}
      confirmDisabled={malformed}
      problem={problemOf(act.error, refusal)}
      onConfirm={act.run}
      onCancel={props.onClose}
    >
      <FormField
        label="Weekly pattern changed on (optional)"
        helper="The first day of a lasting change, such as the day lunch service ended."
        value={regime}
        onChangeText={setRegime}
        placeholder="YYYY-MM-DD"
        autoComplete="off"
        autoCorrect={false}
        numeric
        {...(malformed ? { messages: ['Use the form YYYY-MM-DD.'] } : {})}
      />
    </Dialog>
  );
}

function Row(props: { calibration: Calibration; location: string }): React.JSX.Element {
  const { calibration, location } = props;
  const by = calibration.via === 'console' ? 'Started by Townwise staff' : 'Started by an org admin in TownwiseAI';
  return (
    <Stack gap={4}>
      <Small white>{`${location}, ${formatDate(calibration.requestedAt)}`}</Small>
      <Small>{STATUS_WORDS[calibration.status]}</Small>
      <Small>{by}</Small>
      {calibration.failureWords === null ? null : <Small>{calibration.failureWords}</Small>}
      {calibration.summary === null ? null : summaryLines(calibration.summary).map((line) => <Small key={line}>{line}</Small>)}
      {calibration.gate?.words == null ? null : <Small>{calibration.gate.words}</Small>}
    </Stack>
  );
}

export function Calibrations(props: {
  org: StaffOrg; locations: readonly OrgLocation[]; calibrations: readonly Calibration[]; onStarted: () => Promise<void>;
}): React.JSX.Element {
  const { org, locations, calibrations } = props;
  const [calibrating, setCalibrating] = useState<OrgLocation | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const finished = useCallback(async () => {
    setCalibrating(null);
    setDone('Started.');
    await props.onStarted();
  }, [props]);
  const nameOf = (locationId: string): string => locations.find((location) => location.id === locationId)?.name ?? 'this location';
  return (
    <Stack gap={12}>
      <Heading level={3}>Calibrations</Heading>
      {done === null ? null : <Messages live="status" items={[done]} />}
      {locations.map((location) => (
        <RowActions key={location.id}>
          <Small white>{location.name}</Small>
          <Button
            variant="outline"
            label="Calibrate"
            accessibilityLabel={`Calibrate ${location.name}`}
            onPress={() => { setDone(null); setCalibrating(location); }}
          />
        </RowActions>
      ))}
      {calibrations.length === 0
        ? <Small>No calibrations yet.</Small>
        : calibrations.map((calibration) => <Row key={calibration.id} calibration={calibration} location={nameOf(calibration.locationId)} />)}
      {calibrating === null ? null : (
        <CalibrateDialog org={org} location={calibrating} onDone={finished} onClose={() => { setCalibrating(null); }} />
      )}
    </Stack>
  );
}
