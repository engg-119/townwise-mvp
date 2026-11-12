import { useCallback } from 'react';

import { fetchSalesHistory, type SalesHistory } from '../../analytics/api';
import { decodeHistory, type DayRecord } from '../../analytics/history';
import { formatDate } from '../../format';
import { useLoad } from '../../hooks';
import { cellOf } from '../../locations/sales';
import { usePortal } from '../../PortalProvider';
import { DataTable, type Column } from '../../ui/DataTable';
import { EmptyState, ErrorNotice, LoadingLine } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import { VIEW_LIMITS } from '../../viewer/limits';
import type { DataItem } from '../api';
import { itemName } from '../copy';
import { cutLine, daysTableLabel, ITEM } from './copy';

// An upload's days on its item page (P27), on web and native: the days it still holds, oldest first, read from the
// sales history (GET .../sales/history, which names the upload that last wrote each day). The history leaves out a
// turned-off upload's days, so an upload that is off says so instead of reading it, and one whose every day a later
// upload replaced says that. At most VIEW_LIMITS.shownRows days are drawn.

const COLUMNS: readonly Column[] = [
  { key: 'date', label: 'Date' },
  { key: 'guests', label: 'Guests', numeric: true },
  { key: 'sales', label: 'Net sales', numeric: true },
];

/** The days whose last writer is the upload `uploadId`. */
function daysOfUpload(history: SalesHistory, uploadId: string): DayRecord[] {
  const at = history.uploads.findIndex((upload) => upload.id === uploadId);
  return at === -1 ? [] : decodeHistory(history).filter((day) => day.upload === at);
}

export function UploadDays(props: { item: DataItem }): React.JSX.Element {
  const { api } = usePortal();
  const { item } = props;
  const { state, reload } = useLoad(useCallback(
    () => (item.enabled ? fetchSalesHistory(api, item.locationId) : Promise.resolve(null)),
    [api, item.locationId, item.enabled],
  ));
  if (!item.enabled) return <EmptyState text={ITEM.daysOff} />;
  if (state.status === 'loading') return <LoadingLine text={ITEM.loadingDays} />;
  if (state.status === 'failed') return <ErrorNotice error={state.error} onRetry={reload} />;
  const days = state.data === null ? [] : daysOfUpload(state.data, item.ref.slice(2));
  if (days.length === 0) return <EmptyState text={ITEM.noDaysLeft} />;
  const shown = days.slice(0, VIEW_LIMITS.shownRows);
  return (
    <Stack>
      {days.length > shown.length ? <Small>{cutLine(shown.length, days.length, 'days')}</Small> : null}
      <DataTable
        label={daysTableLabel(itemName(item))}
        columns={COLUMNS}
        rows={shown.map((day) => ({
          key: day.date,
          cells: { date: formatDate(day.date), guests: cellOf(day.guests, false), sales: cellOf(day.netSalesCents, true) },
        }))}
      />
    </Stack>
  );
}
