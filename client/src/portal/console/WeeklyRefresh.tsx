import { useCallback, useState } from 'react';

import { formatDate } from '../format';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Button } from '../ui/Button';
import { Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { setSchedulePaused, type Calibration, type ScheduleState, type WeekRow } from './calibrations';
import { Dialog } from './Dialog';
import { problemOf } from './problems';
import type { OrgLocation } from './schemas';

// The weekly refresh in P21's Forecasts (D42): whether it runs, the staff pause (for every organization at once, and for
// the whole weekly worker, TownwiseAI's weekly suggestions included), and
// each location's latest week, with the gate's reason when its calibration finished. Ids and codes only, never a figure.

/** What a week row's outcome says (also the Overview's Weekly refresh column, OverviewOrgs.tsx). */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  starting: 'starting',
  started: 'started',
  start_failed: 'couldn’t start',
  unchanged: 'unchanged',
  not_enough_history: 'not enough history yet',
  cap_reached: 'held by the weekly cap',
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon, Nov 23, 2026" for a YYYY-MM-DD week. */
function weekLabel(week: string): string {
  const weekday = WEEKDAY[new Date(`${week}T00:00:00.000Z`).getUTCDay()] ?? '';
  return `${weekday}, ${formatDate(week)}`;
}

/** "Mon, Nov 23, 2026: started, published (refreshed)", or "No weekly refresh yet." */
export function weekLine(row: WeekRow | undefined, calibrations: readonly Calibration[]): string {
  if (row === undefined) return 'No weekly refresh yet.';
  const outcome = OUTCOME_WORDS[row.outcome] ?? row.outcome;
  const gate = row.calibrationId === null ? null : calibrations.find((calibration) => calibration.id === row.calibrationId)?.gate ?? null;
  const judged = gate === null ? '' : `, ${gate.published ? 'published' : 'a draft'} (${gate.reason})`;
  return `${weekLabel(row.week)}: ${outcome}${judged}`;
}

function scheduleLine(schedule: ScheduleState): string {
  if (!schedule.running) return 'The weekly refresh isn’t running here: the forecast lab or its switch is off.';
  if (schedule.paused !== null) return `Paused by ${schedule.paused.email} on ${formatDate(schedule.paused.at)}.`;
  return 'On: Townwise refits each changed location from 03:00 every Monday in its town, at no charge to the organization.';
}

function PauseDialog(props: { pause: boolean; onDone: () => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { pause, onDone } = props;
  const { api } = usePortal();
  const act = useAction(useCallback(async () => {
    await setSchedulePaused(api, pause);
    await onDone();
  }, [api, pause, onDone]));
  return (
    <Dialog
      title={pause ? 'Pause the weekly refresh for every organization?' : 'Resume the weekly refresh for every organization?'}
      body={pause
        ? 'No scheduled calibration starts and no weekly suggestions are made from the next hourly pass until you resume it. Calibrations already running finish. It is recorded in the audit log.'
        : 'Scheduled calibrations and weekly suggestions start again from the next hourly pass. It is recorded in the audit log.'}
      confirmLabel={pause ? 'Pause' : 'Resume'}
      pendingLabel={pause ? 'Pausing…' : 'Resuming…'}
      pending={act.pending}
      problem={problemOf(act.error)}
      onConfirm={act.run}
      onCancel={props.onClose}
    />
  );
}

export function WeeklyRefresh(props: {
  schedule: ScheduleState; weeks: readonly WeekRow[]; locations: readonly OrgLocation[]; calibrations: readonly Calibration[];
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const { schedule, weeks, locations, calibrations, onChanged } = props;
  const [open, setOpen] = useState(false);
  const done = useCallback(async () => {
    setOpen(false);
    await onChanged();
  }, [onChanged]);
  const paused = schedule.paused !== null;
  return (
    <Stack gap={12}>
      <Heading level={3}>Weekly refresh</Heading>
      <Small>{scheduleLine(schedule)}</Small>
      {schedule.running
        ? <Button variant="outline" label={paused ? 'Resume weekly refresh' : 'Pause weekly refresh'} onPress={() => { setOpen(true); }} />
        : null}
      {locations.map((location) => (
        <Small key={location.id}>{`${location.name}: ${weekLine(weeks.find((row) => row.locationId === location.id), calibrations)}`}</Small>
      ))}
      {open ? <PauseDialog pause={!paused} onDone={done} onClose={() => { setOpen(false); }} /> : null}
    </Stack>
  );
}
