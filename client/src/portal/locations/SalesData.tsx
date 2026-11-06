import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { FileList } from '../files/FileList';
import { formatCount, formatDate, plural } from '../format';
import { useAction, useLoad } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EmptyState, Notice, ReadOnlyLine } from '../ui/feedback';
import { Columns, Section, Stack } from '../ui/layout';
import { Lead, Small } from '../ui/text';
import { deleteSales, fetchSales, fetchSalesDays, type Upload } from './api';
import { formatRange } from './dates';
import { DaysTable, MonthsTable } from './MonthsTable';
import { LoadFailure, Loading, ShowNumbers, UploadAction, useOrgRefreshOnLeave } from './parts';
import { chartRange, chartSummary, SERIES_TITLE, seriesOf } from './sales';
import { SalesChart } from './SalesChart';

// P12 Sales data (spec 16.3, 10.4): the coverage line, the daily chart (web; the text summary and “Show the
// numbers” everywhere, D21), By month, Uploads, and, for org admins, Delete all sales data behind a typed-name
// confirmation. A 404 on the delete means the location was deleted in the meantime: the organization reloads, and
// the location layout says “This location isn’t available.” with the link to Locations (spec 10.9). Under view-as,
// Upload, Delete and the closure-note link are disabled in place. Your files (files/FileList) follows Uploads
// when stored files are on.

const READ_ONLY_ID = 'sales-ro';

function UploadsTable(props: { uploads: readonly Upload[] }): React.JSX.Element {
  return (
    <Stack>
      <DataTable
        label="Uploads"
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'by', label: 'By', flex: 1.6 },
          { key: 'days', label: 'Days', numeric: true, flex: 0.7 },
          { key: 'new', label: 'New', numeric: true, flex: 0.7 },
          { key: 'replaced', label: 'Replaced', numeric: true, flex: 0.8 },
          { key: 'kept', label: 'Unchanged', numeric: true, flex: 0.9 },
          { key: 'range', label: 'Range', flex: 1.6 },
          { key: 'status', label: 'Status', flex: 1.4 },
        ]}
        rows={props.uploads.map((upload) => ({
          key: upload.id,
          cells: {
            date: formatDate(upload.uploadedAt),
            by: upload.uploadedByEmail,
            days: formatCount(upload.dayCount),
            new: formatCount(upload.inserted),
            replaced: formatCount(upload.replaced),
            kept: formatCount(upload.kept),
            range: formatRange(upload.firstDate, upload.lastDate),
            status: upload.status === 'applied' ? 'Finished' : 'This upload didn’t finish. Upload the file again.',
          },
        }))}
      />
      <Small>Unchanged counts the days a member’s upload left as they were, because the location already had them.</Small>
    </Stack>
  );
}

export function SalesData(): React.JSX.Element {
  const { location, org } = useLocation();
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
          <EmptyState
            text={`No sales history yet for ${location.name}. Upload a CSV export from your point-of-sale system. The upload sends Townwise only the date, guest count and net sales for each day.`}
          >
            <UploadAction locationId={location.id} variant="primary" readOnlyId={readOnlyId} />
          </EmptyState>
        </Stack>
        {sales.uploads.length === 0 ? null : (
          <Section kicker="Newest first" title="Uploads"><UploadsTable uploads={sales.uploads} /></Section>
        )}
        <FileList locationId={location.id} />
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
      {sales.uploads.length === 0 ? null : (
        <Section kicker="Newest first" title="Uploads"><UploadsTable uploads={sales.uploads} /></Section>
      )}
      <FileList locationId={location.id} />
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
        body={`This deletes ${plural(coverage.dayCount, 'day', 'days')} of sales data for ${location.name}. Notes stay. This can’t be undone.`}
        typedName={location.name}
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
