import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { formatDate } from '../format';
import { useLoad } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, Messages, Notice, ReadOnlyLine } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Mono, Small } from '../ui/text';
import {
  downloadClean, downloadRaw, listEntries, listFiles, removeFile, removeOriginals, removeRaw, type EntryView, type FileView,
} from './api';
import {
  actionError, cleanName, COPY, deleteAllRawBody, deletedFileLine, deletedOriginalsLine, deleteFileBody, deleteRawBody, entriesLine,
  entryLine, fileLine, fileName, formatSize, KIND_LABEL,
} from './copy';
import { CAN_SAVE_FILES, saveFile } from './download';

// "Your files" on P12 (storage2 2.3 and 2.4): every stored file with what Townwise did with it, a ZIP's files
// inside, and the actions its flags allow: Download original, Download cleaned CSV, Delete original (keeps the
// cleaned copy and days) and Delete file (keeps the days). Org admins also get "Delete all originals for this
// location". Each delete says in words what stays before it runs. Under view-as the API sends no names and no
// download or delete rights, so the list shows kinds and dates, and "Delete all originals" is disabled in place;
// the rows also check view-as themselves. Downloads are web only; native says where to download. While stored files
// are off (503 files_unavailable) the section doesn't show; any other failure shows the error with Try again.

const PAGE = 200;
const READ_ONLY_ID = 'files-ro';

type Confirm =
  | { kind: 'file'; file: FileView }
  | { kind: 'raw'; file: FileView }
  | { kind: 'all' };

/** No list to show: files are off (503 files_unavailable), or the location went away (404, which its own page says). */
function hidden(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.kind !== 'http') return false;
  return (error.status === 503 && error.code === 'files_unavailable') || error.status === 404;
}

function Entries(props: { locationId: string; file: FileView }): React.JSX.Element {
  const { api } = usePortal();
  const [pages, setPages] = useState<{ entries: EntryView[]; next: number | null }[]>([]);
  const [more, setMore] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: null });
  const { state, reload } = useLoad(useCallback(
    () => listEntries(api, props.locationId, props.file.id),
    [api, props.locationId, props.file.id],
  ));
  if (state.status === 'loading') return <Small>Loading the files inside…</Small>;
  if (state.status === 'failed') return <ErrorNotice message={actionError(state.error)} onRetry={reload} />;
  const all = [state.data, ...pages];
  const next = all.at(-1)?.next ?? null;
  const showMore = (): void => {
    if (next === null || more.pending) return;
    setMore({ pending: true, error: null });
    listEntries(api, props.locationId, props.file.id, { after: next }).then(
      (page) => { setPages((list) => [...list, page]); setMore({ pending: false, error: null }); },
      (error: unknown) => { setMore({ pending: false, error }); },
    );
  };
  return (
    <View role="list" aria-label={`Files inside ${fileName(props.file)}`} style={styles.entries}>
      {all.flatMap((page) => page.entries).map((entry) => (
        <View key={entry.index} role="listitem" style={styles.entry}>
          <Mono tone="white">{entry.path ?? KIND_LABEL[entry.kind]}</Mono>
          <Small>{`${formatSize(entry.sizeBytes)} · ${entryLine(entry)}`}</Small>
        </View>
      ))}
      {more.error === null ? null : <Messages live="alert" items={[actionError(more.error)]} />}
      {next === null ? null : <Button variant="link" label={more.pending ? 'Loading…' : COPY.moreEntries} disabled={more.pending} onPress={showMore} />}
    </View>
  );
}

/** A ZIP's count and "See what's inside", its paginated entry list (storage2 2.2): on Sales data and the drop step. */
export function ZipEntries(props: { locationId: string; file: FileView; entries: NonNullable<FileView['entries']> }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.zip}>
      <Small>{entriesLine(props.entries)}</Small>
      <Pressable role="button" aria-expanded={open} onPress={() => { setOpen((value) => !value); }} style={styles.toggle}>
        <Text style={styles.toggleText}>{open ? COPY.hideEntries : COPY.showEntries}</Text>
      </Pressable>
      {open ? <Entries locationId={props.locationId} file={props.file} /> : null}
    </View>
  );
}

function FileRow(props: {
  locationId: string;
  file: FileView;
  onConfirm: (confirm: Confirm) => void;
}): React.JSX.Element {
  const { file } = props;
  const { api } = usePortal();
  const { readOnly } = useReadOnly();
  const [saving, setSaving] = useState<'raw' | 'clean' | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The API sends every flag false under view-as; the row doesn't rely on that alone.
  const canRaw = !readOnly && file.canDownloadRaw && file.rawAvailable;
  const canClean = !readOnly && file.canDownloadClean && file.hasClean;
  const canDeleteRaw = !readOnly && file.canDeleteRaw && file.rawAvailable;
  const canDelete = !readOnly && file.canDelete;

  const save = (which: 'raw' | 'clean'): void => {
    if (saving !== null) return;
    setSaving(which);
    setError(null);
    const blob = which === 'raw' ? downloadRaw(api, props.locationId, file) : downloadClean(api, props.locationId, file.id);
    blob.then(
      (data) => { saveFile(data, which === 'raw' ? (file.name ?? 'file') : cleanName(file)); setSaving(null); },
      (caught: unknown) => { setError(caught); setSaving(null); },
    );
  };

  const meta = `${KIND_LABEL[file.kind]}, ${formatSize(file.sizeBytes)}, uploaded ${formatDate(file.uploadedAt)} by ${file.uploadedByEmail}`;
  return (
    <View role="listitem" style={styles.row}>
      <Text style={styles.name}>{fileName(file)}</Text>
      <Small>{meta}</Small>
      <Small white>{fileLine(file)}</Small>
      {file.rawAvailable || file.status === 'uploading' ? null : <Small>{COPY.rawGone}</Small>}
      {file.entries === null ? null : <ZipEntries locationId={props.locationId} file={file} entries={file.entries} />}
      {(canRaw || canClean) && !CAN_SAVE_FILES ? <Small>{COPY.nativeDownload}</Small> : null}
      <Actions>
        {canRaw && CAN_SAVE_FILES ? (
          <Button
            variant="link"
            label={saving === 'raw' ? COPY.downloading : COPY.downloadRaw}
            accessibilityLabel={`${COPY.downloadRaw}: ${fileName(file)}`}
            disabled={saving !== null}
            onPress={() => { save('raw'); }}
          />
        ) : null}
        {canClean && CAN_SAVE_FILES ? (
          <Button
            variant="link"
            label={saving === 'clean' ? COPY.downloading : COPY.downloadClean}
            accessibilityLabel={`${COPY.downloadClean}: ${fileName(file)}`}
            disabled={saving !== null}
            onPress={() => { save('clean'); }}
          />
        ) : null}
        {canDeleteRaw ? (
          <Button
            variant="link"
            label={COPY.deleteRaw}
            accessibilityLabel={`${COPY.deleteRaw}: ${fileName(file)}`}
            onPress={() => { props.onConfirm({ kind: 'raw', file }); }}
          />
        ) : null}
        {canDelete ? (
          <Button
            variant="link"
            label={COPY.deleteFile}
            accessibilityLabel={`${COPY.deleteFile}: ${fileName(file)}`}
            onPress={() => { props.onConfirm({ kind: 'file', file }); }}
          />
        ) : null}
      </Actions>
      {error === null ? null : <Messages live="alert" items={[actionError(error)]} />}
    </View>
  );
}

/**
 * Mounted under the location layout (P12), which gives it the location's name and the person's role. A delete
 * takes away its opener (the button, or the whole row, once the list reloads), so focus moves to the line that says
 * how it ended.
 */
export function FileList(props: { locationId: string }): React.JSX.Element {
  return <MessageFocus><Files locationId={props.locationId} /></MessageFocus>;
}

function Files(props: { locationId: string }): React.JSX.Element | null {
  const { api } = usePortal();
  const focusMessage = useFocusMessage();
  // Asked one update after the dialog closes: in that update its focus trap still holds focus.
  const [ended, setEnded] = useState(0);
  useEffect(() => { if (ended > 0) focusMessage(); }, [ended, focusMessage]);
  const { location, org } = useLocation();
  const admin = org.role === 'org_admin';
  const { readOnly, line } = useReadOnly();
  const [older, setOlder] = useState<{ files: FileView[]; done: boolean; pending: boolean; error: unknown }>({
    files: [], done: false, pending: false, error: null,
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const { state, reload } = useLoad(useCallback(() => listFiles(api, props.locationId), [api, props.locationId]));
  // The last list of this location, shown while a reload (after a delete) runs, so the section, its notice and
  // focus stay put instead of the whole section leaving until the list answers.
  const [shown, setShown] = useState<{ locationId: string; files: FileView[] } | null>(null);
  if (state.status === 'ready' && (shown?.files !== state.data || shown.locationId !== props.locationId)) {
    setShown({ locationId: props.locationId, files: state.data });
  }
  const kept = shown?.locationId === props.locationId ? shown.files : null;

  if (state.status === 'failed') {
    if (hidden(state.error)) return null;
    return <Section kicker="Stored privately for your organization" title={COPY.yourFiles}><ErrorNotice error={state.error} onRetry={reload} /></Section>;
  }
  const first = state.status === 'ready' ? state.data : kept;
  if (first === null) return null;
  const files = [...first, ...older.files];
  if (files.length === 0 && notice === null) return null;
  const last = files.at(-1);
  const canPageOlder = !older.done && first.length + older.files.length >= PAGE && last !== undefined;
  const anyRaw = files.some((file) => file.rawAvailable && file.status !== 'uploading');

  const fresh = (): void => {
    setOlder({ files: [], done: false, pending: false, error: null });
    reload();
  };

  const showOlder = (): void => {
    if (last === undefined || older.pending) return;
    setOlder((value) => ({ ...value, pending: true, error: null }));
    listFiles(api, props.locationId, { before: last.id }).then(
      (page) => { setOlder((value) => ({ files: [...value.files, ...page], done: page.length < PAGE, pending: false, error: null })); },
      (error: unknown) => { setOlder((value) => ({ ...value, pending: false, error })); },
    );
  };

  const run = (): void => {
    if (confirm === null || pending) return;
    setPending(true);
    setFailure(null);
    const done = (line: string): void => { setPending(false); setConfirm(null); setNotice(line); setEnded((n) => n + 1); fresh(); };
    const failed = (error: unknown): void => { setPending(false); setConfirm(null); setFailure(error); setEnded((n) => n + 1); fresh(); };
    if (confirm.kind === 'file') {
      removeFile(api, props.locationId, confirm.file.id).then((result) => { done(deletedFileLine(result.daysKept)); }, failed);
    } else if (confirm.kind === 'raw') {
      removeRaw(api, props.locationId, confirm.file.id).then(() => { done(COPY.rawDeleted); }, failed);
    } else {
      removeOriginals(api, props.locationId).then((result) => { done(deletedOriginalsLine(result)); }, failed);
    }
  };

  const dialog = confirm === null ? null : confirm.kind === 'file'
    ? { title: COPY.deleteFile, body: deleteFileBody(confirm.file), label: COPY.deleteFile }
    : confirm.kind === 'raw'
      ? { title: COPY.deleteRaw, body: deleteRawBody(confirm.file), label: COPY.deleteRaw }
      : { title: COPY.deleteAllRaw, body: deleteAllRawBody(location.name), label: COPY.deleteAllRaw };

  return (
    <Section kicker="Stored privately for your organization" title={COPY.yourFiles}>
      <Stack>
        {notice === null ? null : <Notice text={notice} />}
        {failure === null ? null : <Messages live="alert" takesFocus items={[actionError(failure)]} />}
        <Small>{COPY.storedPrivately}</Small>
        {admin && anyRaw ? (
          <Actions>
            {readOnly ? (
              <>
                <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} />
                <Button variant="outline" label={COPY.deleteAllRaw} disabled describedBy={READ_ONLY_ID} />
              </>
            ) : <Button variant="outline" label={COPY.deleteAllRaw} onPress={() => { setConfirm({ kind: 'all' }); }} />}
          </Actions>
        ) : null}
        <View role="list" aria-label={COPY.yourFiles} style={styles.list}>
          {files.map((file) => <FileRow key={file.id} locationId={props.locationId} file={file} onConfirm={setConfirm} />)}
        </View>
        {older.error === null ? null : <Messages live="alert" items={[actionError(older.error)]} />}
        {canPageOlder ? <Button variant="link" label={older.pending ? 'Loading…' : 'Show older files'} disabled={older.pending} onPress={showOlder} /> : null}
      </Stack>
      <ConfirmDialog
        visible={dialog !== null}
        title={dialog?.title ?? ''}
        body={dialog?.body ?? ''}
        confirmLabel={dialog?.label ?? ''}
        pendingLabel={COPY.deleting}
        pending={pending}
        onConfirm={run}
        onCancel={() => { setConfirm(null); }}
      />
    </Section>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { borderTopWidth: 1, borderTopColor: c.border },
  row: { gap: theme.space[2], paddingVertical: theme.space[4], borderBottomWidth: 1, borderBottomColor: c.border, minWidth: 0 },
  name: { ...theme.type.ui, color: c.white, flexShrink: 1 },
  zip: { gap: theme.space[2] },
  toggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  toggleText: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  entries: { gap: theme.space[2], paddingLeft: theme.space[4], borderLeftWidth: 1, borderLeftColor: c.border },
  entry: { gap: 2, minWidth: 0 },
});
