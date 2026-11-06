import { useCallback, useState } from 'react';

import { hasCode } from '../errors';
import { formatDate, plural } from '../format';
import { useAction } from '../hooks';
import { usePortal } from '../PortalProvider';
import { Button } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { ErrorNotice, LoadingLine, Messages } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { Heading, Small } from '../ui/text';
import { Dialog } from './Dialog';
import { ForecastImport } from './ForecastImport';
import { changeForecastRun, deleteForecastRun, fetchForecastRuns, STATUS_LABEL, type StaffRun } from './forecasts';
import { CellLines, RowActions } from './parts';
import { problemOf } from './problems';
import type { OrgLocation, StaffOrg } from './schemas';
import { useRefreshable } from './useRefreshable';

// P21's Forecasts (spec 16.4, 14.4): every forecast run staff imported for the organization, by location, with
// Publish (drafts only), Withdraw and Delete, each through a console dialog, and the import. A run is a draft until
// published: owners and TownwiseAI see only published runs, and never the model. Every change is a staff action the
// organization's admins see in their Townwise staff activity. The table shows a run's model, dates and day count,
// never a figure.

type Verb = 'publish' | 'withdraw' | 'delete';

const ACTIVITY = 'Its admins see this in their Townwise staff activity.';

function refusal(error: unknown): string | null {
  if (hasCode(error, 409, 'forecast_run_not_draft')) return 'Only a draft can be published, and this one isn’t a draft anymore.';
  if (hasCode(error, 409, 'forecast_run_importing')) return 'Its import hasn’t finished. Import the same file again first.';
  if (hasCode(error, 404, 'not_found')) return 'This forecast was already deleted.';
  return null;
}

function dialogCopy(verb: Verb, run: StaffRun, org: StaffOrg, location: string): { title: string; body: string; confirm: string; pending: string } {
  const dates = `${formatDate(run.range.from)} to ${formatDate(run.range.to)}`;
  switch (verb) {
    case 'publish':
      return {
        title: `Publish ${run.model.label} for ${location}?`,
        body: `${org.name}’s members and TownwiseAI will see its ranges for ${dates}. ${ACTIVITY}`,
        confirm: 'Publish', pending: 'Publishing…',
      };
    case 'withdraw':
      return {
        title: `Withdraw ${run.model.label} for ${location}?`,
        body: `Members and TownwiseAI stop seeing it. It stays listed here until you delete it. ${ACTIVITY}`,
        confirm: 'Withdraw', pending: 'Withdrawing…',
      };
    case 'delete':
      return {
        title: `Delete ${run.model.label} for ${location}?`,
        body: `This deletes its days and weeks, ${dates}. This can’t be undone. ${ACTIVITY}`,
        confirm: 'Delete forecast', pending: 'Deleting…',
      };
  }
}

const DONE: Readonly<Record<Verb, string>> = { publish: 'Published.', withdraw: 'Withdrawn.', delete: 'Deleted.' };

function RunDialog(props: {
  verb: Verb; run: StaffRun; org: StaffOrg; location: string; onDone: () => Promise<void>; onClose: () => void;
}): React.JSX.Element {
  const { verb, run, org, onDone } = props;
  const { api } = usePortal();
  const act = useAction(useCallback(async () => {
    if (verb === 'delete') await deleteForecastRun(api, org.id, run.id);
    else await changeForecastRun(api, org.id, run.id, verb);
    await onDone();
  }, [api, org.id, run.id, verb, onDone]));
  const copy = dialogCopy(verb, run, org, props.location);
  return (
    <Dialog
      title={copy.title}
      body={copy.body}
      confirmLabel={copy.confirm}
      pendingLabel={copy.pending}
      pending={act.pending}
      problem={problemOf(act.error, refusal)}
      onConfirm={act.run}
      onCancel={props.onClose}
    />
  );
}

function statusNote(run: StaffRun): string | null {
  if (run.status === 'importing') return 'Import the same file again to finish.';
  if (run.status === 'published' && run.publishedAt !== null) return formatDate(run.publishedAt);
  if (run.status === 'withdrawn' && run.withdrawnAt !== null) return formatDate(run.withdrawnAt);
  return null;
}

function RunTable(props: { location: OrgLocation; runs: readonly StaffRun[]; onAct: (verb: Verb, run: StaffRun) => void }): React.JSX.Element {
  const { location, runs, onAct } = props;
  return (
    <DataTable
      label={`Forecasts for ${location.name}`}
      columns={[
        { key: 'model', label: 'Model', flex: 0.7 },
        { key: 'dates', label: 'Dates', flex: 1.6 },
        { key: 'trained', label: 'Trained to' },
        { key: 'made', label: 'Made' },
        { key: 'status', label: 'Status' },
        { key: 'actions', label: 'Actions', hiddenLabel: true, flex: 1.6 },
      ]}
      rows={runs.map((run) => ({
        key: run.id,
        cells: {
          model: run.model.version,
          dates: <CellLines main={`${formatDate(run.range.from)} to ${formatDate(run.range.to)}`} note={plural(run.dayCount, 'day', 'days')} />,
          trained: formatDate(run.dataThrough),
          made: formatDate(run.madeAt),
          status: <CellLines main={STATUS_LABEL[run.status]} note={statusNote(run)} white={run.status === 'published'} />,
          actions: (
            <RowActions>
              {run.status === 'draft' ? (
                <Button label="Publish" accessibilityLabel={`Publish ${run.model.label}, ${formatDate(run.range.from)}`} onPress={() => { onAct('publish', run); }} />
              ) : null}
              {run.status === 'draft' || run.status === 'published' ? (
                <Button variant="link" label="Withdraw" accessibilityLabel={`Withdraw ${run.model.label}, ${formatDate(run.range.from)}`} onPress={() => { onAct('withdraw', run); }} />
              ) : null}
              <Button variant="outline" label="Delete" accessibilityLabel={`Delete ${run.model.label}, ${formatDate(run.range.from)}`} onPress={() => { onAct('delete', run); }} />
            </RowActions>
          ),
        },
      }))}
    />
  );
}

export function ForecastRuns(props: { org: StaffOrg; locations: readonly OrgLocation[] }): React.JSX.Element {
  const { org, locations } = props;
  const { api } = usePortal();
  const { state, reload, refresh, refreshError } = useRefreshable(useCallback(() => fetchForecastRuns(api, org.id), [api, org.id]));
  const [acting, setActing] = useState<{ verb: Verb; run: StaffRun } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const refreshed = useCallback(async () => { await refresh(); }, [refresh]);
  const finished = useCallback(async () => {
    if (acting !== null) setDone(DONE[acting.verb]);
    setActing(null);
    await refresh();
  }, [acting, refresh]);

  const nameOf = (locationId: string): string => locations.find((location) => location.id === locationId)?.name ?? 'this location';
  return (
    <Section kicker="Staff only" title="Forecasts">
      <Stack gap={20}>
        <Small>{`A forecast is a draft until you publish it. ${org.name}’s members and TownwiseAI see only published forecasts, never the model. Each import, publish, withdrawal and deletion is listed in ${org.name}’s Townwise staff activity.`}</Small>
        {state.status === 'loading' ? <LoadingLine text="Loading forecasts…" /> : null}
        {state.status === 'failed' ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
        {refreshError === null ? null : <ErrorNotice message="The forecasts couldn’t load again, so this list may be out of date." onRetry={() => { void refresh(); }} />}
        {done === null ? null : <Messages live="status" items={[done]} />}
        {state.status === 'ready' ? locations.map((location) => {
          const runs = state.data.filter((run) => run.locationId === location.id);
          return (
            <Stack key={location.id} gap={12}>
              <Heading level={3}>{location.name}</Heading>
              {runs.length === 0
                ? <Small>{`No forecast imported for ${location.name}.`}</Small>
                : <RunTable location={location} runs={runs} onAct={(verb, run) => { setDone(null); setActing({ verb, run }); }} />}
            </Stack>
          );
        }) : null}
        <ForecastImport org={org} locations={locations} onImported={refreshed} />
      </Stack>
      {acting === null ? null : (
        <RunDialog verb={acting.verb} run={acting.run} org={org} location={nameOf(acting.run.locationId)} onDone={finished} onClose={() => { setActing(null); }} />
      )}
    </Section>
  );
}
