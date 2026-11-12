import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';

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
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Small } from '../ui/text';
import { getItem, type DataItem } from './api';
import { DATA, dataError, itemName, shownName } from './copy';
import { addedByLine, EDIT, editedLine, ITEM, itemDaysLine, kindLine, renamedLine, statusLine, tooBigToEditLine } from './item/copy';
import type { Editable, Saved } from './item/edit';
import { ItemContent } from './item/ItemContent';
import { RenameForm } from './item/RenameForm';

// P27 One item of Your data (D28), /locations/[locationId]/data/[ref], inside the location layout: the item's name,
// what it is and how it arrived, who added it and when (and who last edited it), whether it is on, its days, the
// downloads the person may take (web), and what it holds (item/ItemContent: an upload's days on every platform, and on
// web a stored file drawn in the browser). An item that is gone (deleted, or replaced by an edit, whose ref changed)
// says so, with the way back. Opening is a read, so it works under view-as, which sends no name and opens no file.
//
// Editing (web, `item.canEdit`: an item kept for reference, for the person who added it or an org admin): Rename opens
// an inline form (item/RenameForm), and Edit, shown once what opened can be edited (item/edit.ts), puts the editor in
// the viewer's place; one that is too big says why instead. While a rename or a save runs, the other actions wait. A
// saved edit lands on the edited item's new ref, or on the copy, with `?saved=` in the address; the page reads that
// once into its own state, says “Saved.” there and drops it from the address, so a reload doesn't say it again.
// Focus moves to the line that says how an action ended (MessageFocus), since each one takes its opener away.

/** One action in the item's header. */
interface ItemAction {
  key: string;
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
}

/** Editing happens on web only, as the file views do (D20, D21). */
const CAN_EDIT = Platform.OS === 'web';

/** The ref in the page's path: read from the path, as the location's id is (shell/LocationShell.tsx). */
function refOf(pathname: string): string {
  const raw = /\/data\/([^/]+)\/?$/.exec(pathname)?.[1] ?? '';
  return decodeURIComponent(raw);
}

function savedLine(saved: string | string[] | undefined): string | null {
  if (saved === 'edited') return EDIT.saved;
  if (saved === 'copy') return EDIT.savedCopy;
  return null;
}

export function ItemPage(): React.JSX.Element {
  return <MessageFocus><ItemOfPath /></MessageFocus>;
}

function ItemOfPath(): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const { readOnly } = useReadOnly();
  const router = useRouter();
  const ref = refOf(usePathname());
  const params = useLocalSearchParams<{ saved?: string }>();
  // How the save that opened this page ended, read once: the address loses it below.
  const [saved] = useState(() => savedLine(params.saved));
  useEffect(() => { if (params.saved !== undefined) router.setParams({ saved: undefined }); }, [params.saved, router]);
  const { state, reload } = useLoad(useCallback(() => getItem(api, location.id, ref), [api, location.id, ref]));
  // The item as last read, kept on screen while `reload` reads it again, so the content stays mounted.
  const [shown, setShown] = useState<DataItem | null>(null);
  if (state.status === 'ready' && shown !== state.data) setShown(state.data);
  const item = state.status === 'ready' ? state.data : state.status === 'loading' && shown?.ref === ref ? shown : null;
  const openRef = useCallback((next: string, how?: Saved) => {
    const href = itemHref(location.id, next);
    router.replace(how === undefined ? href : `${href}?saved=${how}`);
  }, [router, location.id]);
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
  return <Item item={item} viewAs={readOnly} back={back} reload={reload} openRef={openRef} saved={saved} />;
}

function Item(props: {
  item: DataItem;
  viewAs: boolean;
  back: React.ReactNode;
  reload: () => void;
  openRef: (ref: string, saved?: Saved) => void;
  /** “Saved.” when a save opened this page. */
  saved: string | null;
}): React.JSX.Element {
  const { item, saved } = props;
  const { api } = usePortal();
  const [saving, setSaving] = useState<'raw' | 'clean' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<'rename' | 'edit' | null>(null);
  // What opened can be edited (FileView reports it), and a rename or an edit being saved.
  const [editable, setEditable] = useState<Editable | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(saved);
  const focusMessage = useFocusMessage();
  useEffect(() => { if (saved !== null) focusMessage(); }, [saved, focusMessage]);
  const { file } = item;
  const named = (action: string): string => `${action}: ${itemName(item)}`;
  const editing = CAN_EDIT && item.canEdit;

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
  const open = (next: 'rename' | 'edit'): void => {
    setNotice(null);
    setError(null);
    setMode(next);
  };

  const canRaw = file !== null && file.canDownloadRaw && file.rawAvailable;
  const canClean = file !== null && file.canDownloadClean && file.hasClean;
  const actions: ItemAction[] = [];
  if (editing && mode === null) {
    if (editable?.fits === true) {
      actions.push({ key: 'edit', label: EDIT.edit, accessibilityLabel: named(EDIT.edit), disabled: busy, onPress: () => { open('edit'); } });
    }
    actions.push({ key: 'rename', label: EDIT.rename, accessibilityLabel: named(EDIT.rename), disabled: busy, onPress: () => { open('rename'); } });
  }
  if (canRaw && CAN_SAVE_FILES) {
    actions.push({
      key: 'raw', label: saving === 'raw' ? FILE_COPY.downloading : DATA.downloadRaw, accessibilityLabel: named(DATA.downloadRaw),
      disabled: saving !== null || busy, onPress: () => { save('raw'); },
    });
  }
  if (canClean && CAN_SAVE_FILES) {
    actions.push({
      key: 'clean', label: saving === 'clean' ? FILE_COPY.downloading : DATA.downloadClean, accessibilityLabel: named(DATA.downloadClean),
      disabled: saving !== null || busy, onPress: () => { save('clean'); },
    });
  }
  const edited = editedLine(item);
  const days = itemDaysLine(item);

  return (
    <Section title={shownName(item)}>
      <Stack>
        {notice === null ? null : <Notice text={notice} />}
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
        {editing && mode === null && editable?.fits === false ? <Small>{tooBigToEditLine(editable.kind)}</Small> : null}
        {error === null ? null : <Messages live="alert" items={[dataError(error)]} />}
        {mode === 'rename' ? (
          <RenameForm
            item={item}
            onBusy={setBusy}
            onRenamed={(renamed) => {
              setMode(null);
              setNotice(renamedLine(renamed.name ?? shownName(renamed)));
              focusMessage();
              props.reload();
            }}
            onClose={() => { setMode(null); }}
          />
        ) : null}
        <ItemContent
          item={item}
          viewAs={props.viewAs}
          reload={props.reload}
          openRef={props.openRef}
          edit={{ open: mode === 'edit', onEditable: setEditable, onSaving: setBusy, onClose: () => { setMode(null); } }}
        />
      </Stack>
    </Section>
  );
}

const styles = StyleSheet.create({
  lines: { gap: theme.space[1] },
});
