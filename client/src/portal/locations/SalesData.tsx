import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { formatDate, plural } from '../format';
import { useAction, useLoad } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, Notice, ReadOnlyLine } from '../ui/feedback';
import { Columns, Section, Stack } from '../ui/layout';
import { Lead, Small } from '../ui/text';
import { deleteSales, fetchSales, fetchSalesDays } from './api';
import { DaysTable, MonthsTable } from './MonthsTable';
import { shownLocationName } from './naming';
import { LoadFailure, Loading, ShowNumbers, UploadAction, useOrgRefreshOnLeave } from './parts';
import { chartRange, chartSummary, SERIES_TITLE, seriesOf, UPLOADS_OFF_LINE } from './sales';
import { SalesChart } from './SalesChart';

// P12 Sales data (spec 16.3, 10.4): the coverage line, the daily chart (web; the text summary and “Show the
// numbers” everywhere, D21), By month, the link to Your data (D28; uploads and files are listed there), and, for org admins, Delete all sales data behind a typed-name
// confirmation. A 404 on the delete means the location was deleted in the meantime: the organization reloads, and
// the location layout says “This location isn’t available.” with the link to Locations (spec 10.9). Under view-as,
// Upload, Delete and the closure-note link are disabled in place.

const READ_ONLY_ID = 'sales-ro';

/** Uploads and files moved to Your data (D28): one line and a link, so nobody looks for them here. */
function DataLink(props: { locationName: string; locationId: string }): React.JSX.Element {
  return (
    <Section title="Uploads and files">
      <Stack>
        <Small>{`Every upload and file for ${props.locationName} is on Your data, where your team can download it, turn it off or delete it.`}</Small>
        <Actions><LinkButton href={locationHref(props.locationId, 'data')} label="Open Your data" /></Actions>
      </Stack>
    </Section>
  );
}

export function SalesData(): React.JSX.Element {
  const { location, org } = useLocation();
  // The name every line here shows: the organization's with one location (D29).
  const shown = shownLocationName(location, org);
  const { api, reloadOrg } = usePortal();
  const { readOnly, line } = useReadOnly();
  const markStale = useOrgRefreshOnLeave();
  const admin = org.role === 'org_admin';
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const [confirming, setConfirming] = useState(false);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const [deleted, setDeleted] = useState<number | null>(null);

  const { state, reload } = useLoad(useCallback(async () => {
    const sales = await fetchSales(api, location.id);
    const range = chartRange(sales.coverage);
    const days = range === null || sales.coverage.dayCount === 0 ? [] : await fetchSalesDays(api, location.id, range);
    return { sales, days };
  }, [api, location.id]));

  const remove = useAction(useCallback(async () => {
    let result: { deletedDays: number };
    try {
      result = await deleteSales(api, location.id);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) { setConfirming(false); reloadOrg(); return; }
      throw error;
    }
    markStale();
    setConfirming(false);
    setDeleted(result.deletedDays);
    reload();
  }, [api, location.id, markStale, reload, reloadOrg]));

  const notice = deleted === null ? null : <View style={styles.notice}><Notice text={`Deleted ${plural(deleted, 'day', 'days')}.`} /></View>;
  if (state.status === 'loading') return <>{notice}<Loading text="Loading sales data" /></>;
  if (state.status === 'failed') return <>{notice}<LoadFailure error={state.error} onRetry={reload} /></>;

  const { sales, days } = state.data;
  const { coverage } = sales;
  const readOnlyLine = readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />;

  if (coverage.dayCount === 0 || coverage.firstDate === null || coverage.lastDate === null) {
    return (
      <View>
        {notice}
        <Stack>
          {readOnlyLine}
          {sales.uploadsOff === true ? (
            <EmptyState text={UPLOADS_OFF_LINE} />
          ) : (
            <EmptyState
              text={`No sales history yet for ${shown}. Upload a CSV export from your point-of-sale system. The upload sends Townwise only the date, guest count and net sales for each day.`}
            >
              <UploadAction locationId={location.id} variant="primary" readOnlyId={readOnlyId} />
            </EmptyState>
          )}
        </Stack>
        <DataLink locationName={shown} locationId={location.id} />
      </View>
    );
  }

  const series = seriesOf(days);
  const summary = chartSummary(days, series);
  const missing = coverage.missingDays;
  const closureHref = `${locationHref(location.id, 'notes')}?new=closure`;
  return (
    <View>
      {notice}
      <Columns
        main={(
          <Stack>
            {readOnlyLine}
            <Lead>
              {`${plural(coverage.dayCount, 'day', 'days')}, ${formatDate(coverage.firstDate)} to ${formatDate(coverage.lastDate)}. `
                + `${plural(missing, 'day', 'days')} missing in between.`}
            </Lead>
            {missing > 0 ? (
              <Actions>
                <Small>Missing days might be closures.</Small>
                {readOnlyId === null
                  ? <LinkButton href={closureHref} label="Add a closure note." />
                  : <Button variant="link" label="Add a closure note." disabled describedBy={readOnlyId} />}
              </Actions>
            ) : null}
            <Actions><UploadAction locationId={location.id} variant="primary" readOnlyId={readOnlyId} /></Actions>
          </Stack>
        )}
      />
      {days.length === 0 ? null : (
        <Section kicker="Last 365 days of data" title={SERIES_TITLE[series]}>
          <Columns
            main={(
              <Stack gap={12}>
                <SalesChart days={days} series={series} />
                {summary === null ? null : <Small>{summary}</Small>}
                <ShowNumbers>
                  <ScrollView nestedScrollEnabled style={styles.daysScroll}>
                    <DaysTable label="Daily guests and net sales, last 365 days of data" days={days} />
                  </ScrollView>
                </ShowNumbers>
              </Stack>
            )}
          />
        </Section>
      )}
      <Section kicker="Monthly totals" title="By month">
        <Columns
          main={(
            <Stack>
              <MonthsTable locationId={location.id} months={sales.months} />
              <Small>Totals count only the days with a value. Select a month to see its days.</Small>
            </Stack>
          )}
        />
      </Section>
      <DataLink locationName={shown} locationId={location.id} />
      {admin ? (
        <Section kicker="Admins only" title="Delete sales data">
          <Actions>
            {readOnlyId === null
              ? <Button variant="outline" label="Delete all sales data" onPress={() => { setStaleError(remove.error); setConfirming(true); }} />
              : <Button variant="outline" label="Delete all sales data" disabled describedBy={readOnlyId} />}
          </Actions>
        </Section>
      ) : null}
      <ConfirmDialog
        visible={confirming}
        title="Delete all sales data"
        // The count leaves out turned-off days (coverage does, D28), but the delete takes them too, so the words name them.
        body={`This deletes ${plural(coverage.dayCount, 'day', 'days')} of sales data for ${shown}, any days turned off on its Your data page, and every file on that page. Notes stay. This can’t be undone.`}
        typedName={shown}
        confirmLabel="Delete all sales data"
        pendingLabel="Deleting…"
        pending={remove.pending}
        error={remove.error === staleError ? null : remove.error}
        onConfirm={() => { remove.run(); }}
        onCancel={() => { setConfirming(false); }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  notice: { marginBottom: theme.space[8] },
  daysScroll: { maxHeight: 400 },
});
