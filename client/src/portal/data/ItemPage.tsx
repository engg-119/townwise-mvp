import { useCallback, useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { downloadClean, downloadRaw } from '../files/api';
import { cleanName, COPY as FILE_COPY } from '../files/copy';
import { CAN_SAVE_FILES, saveFile } from '../files/download';
import { useLoad } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { itemHref, locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ErrorNotice, LoadingLine, Messages, Notice } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { getItem, type DataItem } from './api';
import { DATA, dataError, itemName, shownName } from './copy';
import { addedByLine, editedLine, ITEM, itemDaysLine, kindLine, statusLine } from './item/copy';
import { ItemContent } from './item/ItemContent';

// P27 One item of Your data (D28), /locations/[locationId]/data/[ref], inside the location layout: the item's name,
// what it is and how it arrived, who added it and when (and who last edited it), whether it is on, its days, the
// downloads the person may take (web), and what it holds (item/ItemContent: an upload's days on every platform, and on
// web a stored file drawn in the browser). An item that is gone (deleted, or replaced by an edit, whose ref changed)
// says so, with the way back. Opening is a read, so it works under view-as, which sends no name and opens no file.
//
// Seams for editing: the header's actions are a list (ItemAction), so Rename and Edit join the downloads there;
// `reload` reads the item again while the page keeps showing it (after a rename); `openRef` shows another ref in this
// one's place (an edit gives the item a new ref).

/** One action in the item's header. */
interface ItemAction {
  key: string;
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}

/** The ref in the page's path: read from the path, as the location's id is (shell/LocationShell.tsx). */
function refOf(pathname: string): string {
  const raw = /\/data\/([^/]+)\/?$/.exec(pathname)?.[1] ?? '';
  return decodeURIComponent(raw);
}

export function ItemPage(): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const { readOnly } = useReadOnly();
  const router = useRouter();
  const ref = refOf(usePathname());
  const { state, reload } = useLoad(useCallback(() => getItem(api, location.id, ref), [api, location.id, ref]));
  // The item as last read, kept on screen while `reload` reads it again, so the content stays mounted.
  const [shown, setShown] = useState<DataItem | null>(null);
  if (state.status === 'ready' && shown !== state.data) setShown(state.data);
  const item = state.status === 'ready' ? state.data : state.status === 'loading' && shown?.ref === ref ? shown : null;
  const openRef = useCallback((next: string) => { router.replace(itemHref(location.id, next)); }, [router, location.id]);
  const dataHref = locationHref(location.id, 'data');
  const back = <LinkButton variant="link" href={dataHref} label={ITEM.back} />;

  if (state.status === 'failed') {
    return (
      <Section>
        {hasCode(state.error, 404, 'not_found') ? <Notice text={ITEM.gone} /> : <ErrorNotice message={dataError(state.error)} onRetry={reload} />}
        {back}
      </Section>
    );
  }
  if (item === null) return <Section><LoadingLine text={ITEM.loading} /></Section>;
  return <Item item={item} viewAs={readOnly} back={back} reload={reload} openRef={openRef} />;
}

function Item(props: {
  item: DataItem;
  viewAs: boolean;
  back: React.ReactNode;
  reload: () => void;
  openRef: (ref: string) => void;
}): React.JSX.Element {
  const { item } = props;
  const { api } = usePortal();
  const [saving, setSaving] = useState<'raw' | 'clean' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { file } = item;
  const named = (action: string): string => `${action}: ${itemName(item)}`;

  const save = (which: 'raw' | 'clean'): void => {
    if (file === null || saving !== null) return;
    setSaving(which);
    setError(null);
    const blob = which === 'raw'
      ? downloadRaw(api, item.locationId, { id: file.id, sizeBytes: item.sizeBytes ?? 0 })
      : downloadClean(api, item.locationId, file.id);
    blob.then(
      (data) => { saveFile(data, which === 'raw' ? (item.name ?? 'file') : cleanName({ name: item.name })); setSaving(null); },
      (caught: unknown) => { setError(caught); setSaving(null); },
    );
  };

  const canRaw = file !== null && file.canDownloadRaw && file.rawAvailable;
  const canClean = file !== null && file.canDownloadClean && file.hasClean;
  const actions: ItemAction[] = [];
  if (canRaw && CAN_SAVE_FILES) {
    actions.push({
      key: 'raw', label: saving === 'raw' ? FILE_COPY.downloading : DATA.downloadRaw, accessibilityLabel: named(DATA.downloadRaw),
      disabled: saving !== null, onPress: () => { save('raw'); },
    });
  }
  if (canClean && CAN_SAVE_FILES) {
    actions.push({
      key: 'clean', label: saving === 'clean' ? FILE_COPY.downloading : DATA.downloadClean, accessibilityLabel: named(DATA.downloadClean),
      disabled: saving !== null, onPress: () => { save('clean'); },
    });
  }
  const edited = editedLine(item);
  const days = itemDaysLine(item);

  return (
    <Section title={shownName(item)}>
      <Stack>
        {props.back}
        <View style={styles.lines}>
          <Small>{kindLine(item)}</Small>
          <Small>{addedByLine(item)}</Small>
          {edited === null ? null : <Small>{edited}</Small>}
          <Small>{statusLine(item)}</Small>
          {days === null ? null : <Small>{days}</Small>}
        </View>
        {(canRaw || canClean) && !CAN_SAVE_FILES ? <Small>{DATA.nativeDownload}</Small> : null}
        {actions.length === 0 ? null : (
          <Actions>
            {actions.map((action) => (
              <Button
                key={action.key}
                variant="outline"
                label={action.label}
                accessibilityLabel={action.accessibilityLabel}
                disabled={action.disabled}
                onPress={action.onPress}
              />
            ))}
          </Actions>
        )}
        {error === null ? null : <Messages live="alert" items={[dataError(error)]} />}
        <ItemContent item={item} viewAs={props.viewAs} reload={props.reload} openRef={props.openRef} />
      </Stack>
    </Section>
  );
}

const styles = StyleSheet.create({
  lines: { gap: theme.space[1] },
});
