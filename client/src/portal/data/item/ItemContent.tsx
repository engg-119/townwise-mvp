import { EmptyState } from '../../ui/feedback';
import { Stack } from '../../ui/layout';
import { Small } from '../../ui/text';
import type { DataItem } from '../api';
import { ITEM } from './copy';
import { UploadDays } from './UploadDays';

// What an item holds, under its details on the item page (P27). Its props are shared with ItemContent.web.tsx, which
// also draws stored files. Native draws no file (D20, D21): an upload shows its days, and a stored file says where it
// opens, as the portal's other web-only pieces do.

export interface ItemContentProps {
  item: DataItem;
  /** Under view-as: stored files are not opened. */
  viewAs: boolean;
  /** Reads the item again, keeping what is shown meanwhile (after a rename). */
  reload: () => void;
  /** Shows another item in this one's place: saving an edit gives the item a new ref. */
  openRef: (ref: string) => void;
}

export function ItemContent(props: ItemContentProps): React.JSX.Element {
  const { item } = props;
  if (item.ref.startsWith('f_')) return <EmptyState text={ITEM.nativeFile} />;
  const { file } = item;
  const views = file !== null && ((file.canDownloadRaw && file.rawAvailable) || (file.canDownloadClean && file.hasClean));
  return (
    <Stack>
      {views ? <Small>{ITEM.nativeFileViews}</Small> : null}
      <UploadDays item={item} />
    </Stack>
  );
}
