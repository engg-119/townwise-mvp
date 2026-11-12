import { useState } from 'react';

import { Stack } from '../../ui/layout';
import { Select } from '../../ui/Select';
import type { DataItem } from '../api';
import { ITEM } from './copy';
import { FileView } from './FileView.web';
import type { ItemContentProps } from './ItemContent';
import type { Which } from './open';
import { UploadDays } from './UploadDays';

// What an item holds, on web (P27): a stored file drawn in the browser (FileView), or an upload's days. A sales file's
// upload also offers its original file and its cleaned copy as other views, each only when the person may download
// it, chosen with Show.

type View = 'days' | Which;

const VIEW_LABEL: Readonly<Record<View, string>> = { days: ITEM.days, raw: ITEM.original, clean: ITEM.clean };

function viewsOf(item: DataItem): View[] {
  const { file } = item;
  const views: View[] = ['days'];
  if (file?.canDownloadRaw === true && file.rawAvailable) views.push('raw');
  if (file?.canDownloadClean === true && file.hasClean) views.push('clean');
  return views;
}

export function ItemContent(props: ItemContentProps): React.JSX.Element {
  const { item, viewAs } = props;
  const [view, setView] = useState<View>('days');
  if (item.ref.startsWith('f_')) return <FileView item={item} which="raw" viewAs={viewAs} />;
  const views = viewAs ? (['days'] as View[]) : viewsOf(item);
  const shown = views.includes(view) ? view : 'days';
  return (
    <Stack>
      {views.length > 1 ? (
        <Select
          label={ITEM.show}
          compact
          value={shown}
          items={views.map((each) => ({ value: each, label: VIEW_LABEL[each] }))}
          onChange={(value) => { setView(views.find((each) => each === value) ?? 'days'); }}
        />
      ) : null}
      {shown === 'days' ? <UploadDays item={item} /> : <FileView key={shown} item={item} which={shown} viewAs={viewAs} />}
    </Stack>
  );
}
