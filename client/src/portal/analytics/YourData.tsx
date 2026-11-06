import { formatCount, formatDate } from '../format';
import { locationHref } from '../routing';
import type { Coverage } from '../schemas';
import { Actions, LinkButton } from '../ui/Button';
import { DefinitionList } from '../ui/DataTable';
import { Stack } from '../ui/layout';
import { Small } from '../ui/text';
import type { HistoryUpload } from './api';

// "Your data" at the bottom of Analytics (home.md 4.1 item 8): the data checks P11 shows (days with data, first and
// last day, missing days, days with guests and with net sales, the last finished upload and who sent it), what
// this page reads and that it keeps nothing, and the link to Sales data, which lists the uploads and files.

export const READS_LINE = 'Analytics reads your stored days, your notes, your town’s calendar and how Townwise estimates. It changes nothing and keeps nothing, not even your filters: they reset when you leave the page.';

/** The newest finished upload among those that wrote a stored day. */
function lastFinished(uploads: readonly HistoryUpload[]): HistoryUpload | undefined {
  return uploads.filter((upload) => upload.status === 'applied').sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0];
}

export function YourData(props: { coverage: Coverage; uploads: readonly HistoryUpload[]; locationId: string }): React.JSX.Element {
  const { coverage } = props;
  const last = lastFinished(props.uploads);
  return (
    <Stack>
      <DefinitionList
        mono
        items={[
          { term: 'Days with data', value: formatCount(coverage.dayCount) },
          { term: 'First day', value: coverage.firstDate === null ? 'None' : formatDate(coverage.firstDate) },
          { term: 'Last day', value: coverage.lastDate === null ? 'None' : formatDate(coverage.lastDate) },
          { term: 'Missing days in between', value: formatCount(coverage.missingDays) },
          { term: 'Days with guests', value: formatCount(coverage.guestsDayCount) },
          { term: 'Days with net sales', value: formatCount(coverage.netSalesDayCount) },
          { term: 'Last upload', value: last === undefined ? 'No finished upload' : `${formatDate(last.uploadedAt)} by ${last.uploadedByEmail}` },
        ]}
      />
      <Small>{READS_LINE}</Small>
      <Actions><LinkButton href={locationHref(props.locationId, 'sales')} label="Sales data" /></Actions>
    </Stack>
  );
}
