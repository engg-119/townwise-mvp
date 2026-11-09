import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { hasCode } from '../errors';
import { useLoad } from '../hooks';
import { downloadClean, downloadRaw, listFiles, removeRaw } from '../files/api';
import { cleanName, COPY as FILE_COPY, deleteAllRawBody, deletedOriginalsLine, deleteRawBody, formatSize } from '../files/copy';
import { CAN_SAVE_FILES, saveFile } from '../files/download';
import { removeOriginals } from '../files/api';
import { ZipEntries } from '../files/ZipEntries';
import { LoadFailure, UploadAction } from '../locations/parts';
import { CAN_DROP } from '../onboarding/HistoryStepDrop';
import { usePortal, useReadOnly } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable, type Column } from '../ui/DataTable';
import { EmptyState, LoadingLine, Messages, Notice, ReadOnlyLine } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Select } from '../ui/Select';
import { Lead, Small } from '../ui/text';
import { AddFile } from './AddFile';
import { listData, removeItem, setEnabled, type DataItem } from './api';
import {
  addedLine, COLUMNS, DATA, dataError, daysLine, deletedFileLine, deletedUploadLine, deleteFileBody, deleteUploadBody, empty, itemName,
  kindLabel, lead, stateLine, tableLabel, turnedOffLine, turnedOnLine, VIA_LINE,
} from './copy';
import { PasteText } from './PasteText';

// P26 Your data (D28), /locations/[locationId]/data: every upload and stored file a location received, newest
// first, with what Townwise did with it and the actions the person may take: Turn off or on (acts at once), the
// downloads (web), and the deletes, each of which says in words what goes and what stays. “Show” widens the list to
// every location. Under view-as the API sends no names and no rights: the rows show kinds and dates, and every
// action is disabled in place under the read-only line. Stored files off (503) hides Add a file, Paste text and
// the file actions; uploads still list, turn off and delete. A delete takes its opener away, so focus moves to the
// line that says how it ended (MessageFocus, as Your files did).

const READ_ONLY_ID = 'data-ro';
const ALL = 'all';

type Confirm =
  | { kind: 'upload'; item: DataItem }
  | { kind: 'file'; item: DataItem }
  | { kind: 'raw'; item: DataItem }
  | { kind: 'all' };

export function DataPage(): React.JSX.Element {
  return <MessageFocus><Data /></MessageFocus>;
}

function Data(): React.JSX.Element {
  const { api } = usePortal();
  const { location, org } = useLocation();
  const { readOnly, line } = useReadOnly();
  const admin = org.role === 'org_admin';
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const several = org.locations.length > 1;
  const focusMessage = useFocusMessage();
  // Asked one update after a dialog closes: in that update its focus trap still holds focus.
  const [ended, setEnded] = useState(0);
  useEffect(() => { if (ended > 0) focusMessage(); }, [ended, focusMessage]);

  const [showAll, setShowAll] = useState(false);
  const all = several && showAll;
  const scope = all ? ALL : location.id;
  const nameOf = (locationId: string): string => org.locations.find((candidate) => candidate.id === locationId)?.name ?? location.name;

  const { state, reload } = useLoad(useCallback(
    () => listData(api, scope === ALL ? {} : { locationId: scope }).then((page) => ({ scope, page })),
    [api, scope],
  ));
  // The last list of this scope, shown while a reload runs, so the section, its notice and focus stay put.
  const [shown, setShown] = useState<{ scope: string; items: DataItem[]; next: string | null } | null>(null);
  if (state.status === 'ready' && state.data.scope === scope && (shown?.scope !== scope || shown.items !== state.data.page.items)) {
    setShown({ scope, items: state.data.page.items, next: state.data.page.next });
  }
  const [older, setOlder] = useState<{ items: DataItem[]; next: string | null | undefined; pending: boolean; error: unknown }>({
    items: [], next: undefined, pending: false, error: null,
  });
  // A row as the API last answered it, after Turn off or on, until the list loads again.
  const [patched, setPatched] = useState<Readonly<Record<string, DataItem>>>({});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Stored files on or off, asked of the first file list: off answers 503 files_unavailable. Web only.
  const probe = useLoad(useCallback(async () => {
    if (!CAN_DROP) return false;
    try {
      await listFiles(api, location.id);
      return true;
    } catch (error) {
      return !hasCode(error, 503, 'files_unavailable');
    }
  }, [api, location.id]));
  const filesOn = probe.state.status === 'ready' && probe.state.data;

  const fresh = useCallback((): void => {
    setOlder({ items: [], next: undefined, pending: false, error: null });
    setPatched({});
    reload();
  }, [reload]);

  const saveDownload = (item: DataItem, which: 'raw' | 'clean'): void => {
    const file = item.file;
    if (file === null || busy !== null) return;
    setBusy(`${item.ref}:${which}`);
    setFailure(null);
    const blob = which === 'raw'
      ? downloadRaw(api, item.locationId, { id: file.id, sizeBytes: item.sizeBytes ?? 0 })
      : downloadClean(api, item.locationId, file.id);
    blob.then(
      (data) => { saveFile(data, which === 'raw' ? (item.name ?? 'file') : cleanName({ name: item.name })); setBusy(null); },
      (error: unknown) => { setFailure(error); setBusy(null); },
    );
  };

  const toggle = (item: DataItem): void => {
    if (busy !== null) return;
    const enable = !item.enabled;
    setBusy(item.ref);
    setFailure(null);
    setEnabled(api, item.locationId, item.ref, enable).then(
      (updated) => {
        setBusy(null);
        setPatched((value) => ({ ...value, [item.ref]: updated }));
        setNotice(enable ? turnedOnLine(itemName(item)) : turnedOffLine(itemName(item), nameOf(item.locationId)));
        setEnded((n) => n + 1);
      },
      (error: unknown) => {
        setBusy(null);
        setFailure(error);
        setEnded((n) => n + 1);
        if (error instanceof ApiError && error.kind === 'http' && error.status === 404) fresh();
      },
    );
  };

  if (state.status === 'failed' && shown === null) return <LoadFailure error={state.error} onRetry={reload} />;
  const first = state.status === 'ready' && state.data.scope === scope ? state.data.page.items : shown?.scope === scope ? shown.items : null;
  const firstNext = state.status === 'ready' && state.data.scope === scope ? state.data.page.next : shown?.scope === scope ? shown.next : null;

  const items = first === null ? null : [...first, ...older.items].map((item) => patched[item.ref] ?? item);
  const next = older.next === undefined ? firstNext : older.next;
  const anyOriginal = items?.some((item) => item.file !== null && item.file.rawAvailable && item.state !== 'uploading') === true;

  const showOlder = (): void => {
    if (next === null || older.pending) return;
    setOlder((value) => ({ ...value, pending: true, error: null }));
    listData(api, { ...(scope === ALL ? {} : { locationId: scope }), after: next }).then(
      (page) => { setOlder((value) => ({ items: [...value.items, ...page.items], next: page.next, pending: false, error: null })); },
      (error: unknown) => { setOlder((value) => ({ ...value, pending: false, error })); },
    );
  };

  const run = (): void => {
    if (confirm === null || pending) return;
    setPending(true);
    setFailure(null);
    const done = (text: string): void => { setPending(false); setConfirm(null); setNotice(text); setEnded((n) => n + 1); fresh(); };
    const failed = (error: unknown): void => {
      setPending(false);
      setConfirm(null);
      setFailure(error);
      setEnded((n) => n + 1);
      fresh();
    };
    if (confirm.kind === 'upload') {
      const { item } = confirm;
      removeItem(api, item.locationId, item.ref).then((result) => { done(deletedUploadLine(result.deletedDays)); }, failed);
    } else if (confirm.kind === 'file') {
      const { item } = confirm;
      removeItem(api, item.locationId, item.ref).then(() => { done(deletedFileLine(itemName(item))); }, failed);
    } else if (confirm.kind === 'raw') {
      const { item } = confirm;
      if (item.file === null) return;
      removeRaw(api, item.locationId, item.file.id).then(() => { done(FILE_COPY.rawDeleted); }, failed);
    } else {
      removeOriginals(api, location.id).then((result) => { done(deletedOriginalsLine(result)); }, failed);
    }
  };

  const dialog = confirm === null ? null : dialogOf(confirm, nameOf, location.name);

  const columns: Column[] = [
    { key: 'item', label: COLUMNS.item, flex: 1.6 },
    ...(all ? [{ key: 'location', label: COLUMNS.location, flex: 1.1 }] : []),
    { key: 'added', label: COLUMNS.added, flex: 1.5 },
    { key: 'kind', label: COLUMNS.kind, flex: 1 },
    { key: 'size', label: COLUMNS.size, flex: 0.8 },
    { key: 'status', label: COLUMNS.status, flex: 1.4 },
    { key: 'days', label: COLUMNS.days, flex: 1.4 },
    { key: 'actions', label: COLUMNS.actions, flex: 1.6, hiddenLabel: true },
  ];

  const rowActions = (item: DataItem): React.JSX.Element => {
    const file = item.file;
    const name = itemName(item);
    const named = (action: string): string => `${action}: ${name}`;
    if (readOnly) {
      const action = item.enabled ? DATA.turnOff : DATA.turnOn;
      return (
        <Actions>
          <Button variant="link" label={action} accessibilityLabel={named(action)} disabled describedBy={READ_ONLY_ID} />
          <Button variant="link" label={DATA.delete} accessibilityLabel={named(DATA.delete)} disabled describedBy={READ_ONLY_ID} />
        </Actions>
      );
    }
    const canRaw = file !== null && file.canDownloadRaw && file.rawAvailable;
    const canClean = file !== null && file.canDownloadClean && file.hasClean;
    const canDeleteRaw = file !== null && file.canDeleteRaw && file.rawAvailable;
    const action = item.enabled ? DATA.turnOff : DATA.turnOn;
    return (
      <View style={styles.actions}>
        {(canRaw || canClean) && !CAN_SAVE_FILES ? <Small>{DATA.nativeDownload}</Small> : null}
        <Actions>
          {item.canTurnOff ? (
            <Button variant="link" label={action} accessibilityLabel={named(action)} disabled={busy !== null} onPress={() => { toggle(item); }} />
          ) : null}
          {canRaw && CAN_SAVE_FILES ? (
            <Button
              variant="link"
              label={busy === `${item.ref}:raw` ? FILE_COPY.downloading : DATA.downloadRaw}
              accessibilityLabel={named(DATA.downloadRaw)}
              disabled={busy !== null}
              onPress={() => { saveDownload(item, 'raw'); }}
            />
          ) : null}
          {canClean && CAN_SAVE_FILES ? (
            <Button
              variant="link"
              label={busy === `${item.ref}:clean` ? FILE_COPY.downloading : DATA.downloadClean}
              accessibilityLabel={named(DATA.downloadClean)}
              disabled={busy !== null}
              onPress={() => { saveDownload(item, 'clean'); }}
            />
          ) : null}
          {canDeleteRaw ? (
            <Button
              variant="link"
              label={DATA.deleteOriginal}
              accessibilityLabel={named(DATA.deleteOriginal)}
              onPress={() => { setConfirm({ kind: 'raw', item }); }}
            />
          ) : null}
          {item.canDelete ? (
            <Button
              variant="link"
              label={DATA.delete}
              accessibilityLabel={named(DATA.delete)}
              onPress={() => { setConfirm({ kind: item.ref.startsWith('u_') ? 'upload' : 'file', item }); }}
            />
          ) : null}
        </Actions>
      </View>
    );
  };

  const rows = (items ?? []).map((item) => ({
    key: item.ref,
    cells: {
      item: <ItemCell item={item} />,
      location: nameOf(item.locationId),
      added: addedLine(item),
      kind: kindLabel(item.kind),
      size: item.sizeBytes === null ? DATA.noFileKept : formatSize(item.sizeBytes),
      status: <StatusCell item={item} />,
      days: daysLine(item.days),
      actions: rowActions(item),
    },
  }));

  const stored = filesOn && !all;
  return (
    <Section kicker={DATA.kicker} title={DATA.title}>
      <Stack>
        {notice === null ? null : <Notice text={notice} />}
        {failure === null ? null : <Messages live="alert" takesFocus items={[dataError(failure)]} />}
        <Lead>{lead(all ? DATA.allLocations.toLowerCase() : location.name)}</Lead>
        {readOnly ? <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} /> : null}
        {several ? (
          <Select
            label={DATA.show}
            compact
            value={scope}
            items={[{ value: location.id, label: location.name }, { value: ALL, label: DATA.allLocations }]}
            onChange={(value) => { setShowAll(value === ALL); setOlder({ items: [], next: undefined, pending: false, error: null }); setPatched({}); }}
          />
        ) : null}
        <Actions>
          <UploadAction locationId={location.id} variant="primary" readOnlyId={readOnlyId} nativeText={DATA.nativeUpload} />
        </Actions>
        {CAN_DROP && filesOn ? (
          <Stack>
            <Actions>
              <AddFile
                locationId={location.id}
                enabled={!readOnly}
                {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
                onStored={fresh}
              />
              <Button
                variant="outline"
                label={DATA.pasteText}
                disabled={readOnly}
                {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
                onPress={() => { setAdding(true); }}
              />
            </Actions>
            <Small>{DATA.addFileHelp}</Small>
            {adding && !readOnly ? (
              <PasteText
                locationId={location.id}
                onCancel={() => { setAdding(false); }}
                onSaved={(title) => { setAdding(false); setNotice(`Saved ${title}.`); setEnded((n) => n + 1); fresh(); }}
              />
            ) : null}
          </Stack>
        ) : null}
        {stored && admin && anyOriginal ? (
          <Actions>
            {readOnly
              ? <Button variant="outline" label={FILE_COPY.deleteAllRaw} disabled describedBy={READ_ONLY_ID} />
              : <Button variant="outline" label={FILE_COPY.deleteAllRaw} onPress={() => { setConfirm({ kind: 'all' }); }} />}
          </Actions>
        ) : null}
        {items === null ? <LoadingLine text={DATA.loading} /> : items.length === 0 ? (
          <EmptyState text={empty(all ? DATA.allLocations.toLowerCase() : location.name)} />
        ) : (
          <DataTable label={tableLabel(all ? null : location.name)} columns={columns} rows={rows} />
        )}
        {older.error === null ? null : <Messages live="alert" items={[dataError(older.error)]} />}
        {next === null || items === null || items.length === 0 ? null : (
          <Button variant="link" label={older.pending ? DATA.loadingMore : DATA.more} disabled={older.pending} onPress={showOlder} />
        )}
      </Stack>
      <ConfirmDialog
        visible={dialog !== null}
        title={dialog?.title ?? ''}
        body={dialog?.body ?? ''}
        confirmLabel={dialog?.label ?? ''}
        pendingLabel={DATA.deleting}
        pending={pending}
        onConfirm={run}
        onCancel={() => { setConfirm(null); }}
      />
    </Section>
  );
}

function dialogOf(confirm: Confirm, nameOf: (locationId: string) => string, locationName: string): { title: string; body: string; label: string } {
  switch (confirm.kind) {
    case 'upload':
      return { title: DATA.deleteUploadTitle, body: deleteUploadBody(confirm.item, nameOf(confirm.item.locationId)), label: DATA.deleteUploadConfirm };
    case 'file':
      return { title: DATA.deleteFileTitle, body: deleteFileBody(itemName(confirm.item)), label: DATA.deleteFileConfirm };
    case 'raw':
      return {
        title: FILE_COPY.deleteRaw,
        body: deleteRawBody({
          name: confirm.item.name, kind: confirm.item.kind === 'daily_totals' ? 'other' : confirm.item.kind, uploadedAt: confirm.item.addedAt,
        }),
        label: FILE_COPY.deleteRaw,
      };
    case 'all':
      return { title: FILE_COPY.deleteAllRaw, body: deleteAllRawBody(locationName), label: FILE_COPY.deleteAllRaw };
  }
}

function ItemCell(props: { item: DataItem }): React.JSX.Element {
  const { item } = props;
  const entries = item.file?.entries ?? null;
  return (
    <View style={styles.cell}>
      <Text style={styles.name}>{itemName(item)}</Text>
      <Text style={styles.note}>{VIA_LINE[item.via]}</Text>
      {item.file === null || entries === null ? null : (
        <ZipEntries
          locationId={item.locationId}
          file={{ id: item.file.id, name: item.name, kind: item.kind === 'daily_totals' ? 'other' : item.kind, uploadedAt: item.addedAt }}
          entries={entries}
        />
      )}
    </View>
  );
}

function StatusCell(props: { item: DataItem }): React.JSX.Element {
  const { item } = props;
  return (
    <View style={styles.cell}>
      <Text style={styles.value}>{item.enabled ? DATA.on : DATA.off}</Text>
      <Text style={styles.note}>{stateLine(item)}</Text>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  cell: { gap: 2, minWidth: 0 },
  name: { ...theme.type.mono, color: c.white },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  note: { ...theme.type.small, color: c.text2 },
  actions: { gap: theme.space[1], minWidth: 0 },
});
