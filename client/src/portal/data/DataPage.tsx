import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { hasCode } from '../errors';
import { useLoad } from '../hooks';
import { downloadClean, downloadRaw, listFiles, removeOriginals, removeRaw } from '../files/api';
import { cleanName, COPY as FILE_COPY, deleteAllRawBody, deletedOriginalsLine, deleteRawBody, formatSize } from '../files/copy';
import { CAN_SAVE_FILES, saveFile } from '../files/download';
import { ZipEntries } from '../files/ZipEntries';
import { shownLocationName } from '../locations/naming';
import { LoadFailure, UploadAction, useOrgRefreshOnLeave } from '../locations/parts';
import { CAN_DROP } from '../onboarding/HistoryStepDrop';
import { usePortal, useReadOnly } from '../PortalProvider';
import { itemHref, locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { TableSkeleton } from '../skeleton';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable, type Column } from '../ui/DataTable';
import { EmptyState, Messages, Notice, ReadOnlyLine } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Select } from '../ui/Select';
import { Lead, Small } from '../ui/text';
import { AddFile } from './AddFile';
import { rowAiLine } from './aiCopy';
import { listData, removeItem, setEnabled, type DataItem } from './api';
import {
  addedLine, COLUMNS, DATA, dataError, daysLine, deletedFileLine, deletedUploadLine, deleteFileBody, deleteUploadBody, empty, itemName,
  kindLabel, lead, shownName, stateLine, tableLabel, turnedOffLine, turnedOnLine, VIA_LINE,
} from './copy';
import { PasteText } from './PasteText';

// P26 Your data (D28), /locations/[locationId]/data: every upload and stored file a location received, newest
// first, with what Townwise did with it and the actions the person may take: Open (its own page, P27, ItemPage.tsx),
// Turn off or on (acts at once), the downloads (web), and the deletes, each of which says in words what goes and what
// stays. “Show” widens the list to every location. Under view-as the API sends no names and no rights: the rows show
// kinds and dates, and every action but Open is disabled in place under the read-only line. Stored files off (503) hides Add a file, Paste text and
// the file actions; uploads still list, turn off and delete. A delete takes its opener away, so focus moves to the
// line that says how it ended (MessageFocus, as Your files did). Turning an item off or on and deleting one change
// the location's day counts, so the organization (GET /api/org) is read again when the page closes. An item kept
// for reference is its original, so it has Delete and no Delete original. Org admins also get "Delete all originals
// for this location" (one location shown, a sales file's original stored), which leaves reference items whole. A
// download keeps its state in its row, as Your files' rows did: only that row's downloads wait, and its error shows
// there. Item sales, the ordering setup and counts are not listed here; one line points to Ordering setup.

const READ_ONLY_ID = 'data-ro';
const ALL = 'all';

type Confirm =
  | { kind: 'upload'; item: DataItem }
  | { kind: 'file'; item: DataItem }
  | { kind: 'raw'; item: DataItem }
  | { kind: 'all'; locationId: string };

/** A stored file kept for reference: the original is the whole item, with no cleaned copy and no days. */
function isReference(item: Pick<DataItem, 'ref' | 'outcome'>): boolean {
  return item.ref.startsWith('f_') && item.outcome === 'reference';
}

export function DataPage(): React.JSX.Element {
  return <MessageFocus><Data /></MessageFocus>;
}

function Data(): React.JSX.Element {
  const { api } = usePortal();
  const { location, org } = useLocation();
  const { readOnly, line } = useReadOnly();
  const markStale = useOrgRefreshOnLeave();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const admin = org.role === 'org_admin';
  const several = org.locations.length > 1;
  // The lead, the empty line and the table name it as member pages do: the organization's name with one location (D29).
  const locationName = shownLocationName(location, org);
  const focusMessage = useFocusMessage();
  // Asked one update after a dialog closes: in that update its focus trap still holds focus.
  const [ended, setEnded] = useState(0);
  useEffect(() => { if (ended > 0) focusMessage(); }, [ended, focusMessage]);

  const [showAll, setShowAll] = useState(false);
  const all = several && showAll;
  const scope = all ? ALL : location.id;
  // The notices and dialogs name a location by its shown name too: the organization's with one location (D29).
  const nameOf = (locationId: string): string => shownLocationName(org.locations.find((candidate) => candidate.id === locationId) ?? location, org);

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
  // The ref of the item a Turn off or on is running for.
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

  const toggle = (item: DataItem): void => {
    if (busy !== null) return;
    const enable = !item.enabled;
    setBusy(item.ref);
    setFailure(null);
    setEnabled(api, item.locationId, item.ref, enable).then(
      (updated) => {
        markStale();
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

  // A failed load (the first, after Show changed, or again after a write) shows in place of the list, with Try
  // again; the rest of the page stays, so Show can still switch back. Rows from before are not kept: they may be stale.
  const loadError = state.status === 'failed' ? state.error : null;
  const kept = loadError === null && shown?.scope === scope ? shown : null;
  const first = state.status === 'ready' && state.data.scope === scope ? state.data.page.items : kept?.items ?? null;
  const firstNext = state.status === 'ready' && state.data.scope === scope ? state.data.page.next : kept?.next ?? null;

  const items = first === null ? null : [...first, ...older.items].map((item) => patched[item.ref] ?? item);
  const next = older.next === undefined ? firstNext : older.next;

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
    const done = (text: string): void => { markStale(); setPending(false); setConfirm(null); setNotice(text); setEnded((n) => n + 1); fresh(); };
    // The delete may have taken effect even so (a lost answer), so the organization is read again too.
    const failed = (error: unknown): void => {
      markStale();
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
      removeOriginals(api, confirm.locationId).then((result) => { done(deletedOriginalsLine(result)); }, failed);
    }
  };

  const dialog = confirm === null ? null : dialogOf(confirm, nameOf);

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
      actions: (
        <RowActions item={item} readOnly={readOnly} toggling={busy !== null} onToggle={toggle} onConfirm={setConfirm} />
      ),
    },
  }));
  // A sales file's original the reader is done with, at the one location shown: what "Delete all originals" deletes.
  const anyRaw = !all && (items ?? []).some((item) => item.file !== null && item.file.rawAvailable && item.state !== 'uploading' && !isReference(item));

  return (
    <Section kicker={DATA.kicker} title={DATA.title}>
      <Stack>
        {notice === null ? null : <Notice text={notice} />}
        {failure === null ? null : <Messages live="alert" takesFocus items={[dataError(failure)]} />}
        <Lead>{lead(all ? DATA.allLocations.toLowerCase() : locationName)}</Lead>
        <View style={styles.ordering}>
          <Small>{DATA.ordering}</Small>
          <LinkButton href={locationHref(location.id, 'ordersSetup')} label={DATA.orderingLink} />
        </View>
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
            {/* Not in a row with Paste text: the opt-in under Add a file is taller, and would push it out of line. */}
            <AddFile
              locationId={location.id}
              enabled={!readOnly}
              {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
              onStored={fresh}
              onAsked={fresh}
            />
            <Small>{DATA.addFileHelp}</Small>
            <Actions>
              <Button
                variant="outline"
                label={DATA.pasteText}
                disabled={readOnly}
                {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
                onPress={() => { setAdding(true); }}
              />
            </Actions>
            {adding && !readOnly ? (
              <PasteText
                locationId={location.id}
                onCancel={() => { setAdding(false); }}
                onSaved={(title) => { setAdding(false); setNotice(`Saved ${title}.`); setEnded((n) => n + 1); fresh(); }}
              />
            ) : null}
          </Stack>
        ) : null}
        {admin && anyRaw ? (
          <Actions>
            <Button
              variant="outline"
              label={FILE_COPY.deleteAllRaw}
              disabled={readOnly}
              {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
              onPress={() => { setConfirm({ kind: 'all', locationId: location.id }); }}
            />
          </Actions>
        ) : null}
        {loadError !== null ? <LoadFailure error={loadError} onRetry={reload} /> : items === null ? <TableSkeleton name="data" label={DATA.loading} columns={columns} rowHeight={56} /> : items.length === 0 ? (
          <EmptyState text={empty(all ? DATA.allLocations.toLowerCase() : locationName)} />
        ) : (
          <DataTable label={tableLabel(all ? null : locationName)} columns={columns} rows={rows} />
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

function dialogOf(confirm: Confirm, nameOf: (locationId: string) => string): { title: string; body: string; label: string } {
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
      return { title: FILE_COPY.deleteAllRaw, body: deleteAllRawBody(nameOf(confirm.locationId)), label: FILE_COPY.deleteAllRaw };
  }
}

/**
 * One row's actions. Turn off and on act at once; a delete asks first. A download keeps its own state, so only this
 * row's download buttons wait for it, and a failed one says why here, beside the button the person pressed.
 */
function RowActions(props: {
  item: DataItem;
  readOnly: boolean;
  /** A Turn off or on is running, on this row or another. */
  toggling: boolean;
  onToggle: (item: DataItem) => void;
  onConfirm: (confirm: Confirm) => void;
}): React.JSX.Element {
  const { item } = props;
  const { api } = usePortal();
  const [saving, setSaving] = useState<'raw' | 'clean' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const file = item.file;
  const name = itemName(item);
  const named = (action: string): string => `${action}: ${name}`;
  const action = item.enabled ? DATA.turnOff : DATA.turnOn;
  // Opening is a read, so it stays under view-as. An item still uploading has nothing to open yet.
  const open = item.state === 'uploading' ? null : (
    <LinkButton variant="link" href={itemHref(item.locationId, item.ref)} label={DATA.open} accessibilityLabel={named(DATA.open)} />
  );
  if (props.readOnly) {
    return (
      <Actions>
        {open}
        <Button variant="link" label={action} accessibilityLabel={named(action)} disabled describedBy={READ_ONLY_ID} />
        <Button variant="link" label={DATA.delete} accessibilityLabel={named(DATA.delete)} disabled describedBy={READ_ONLY_ID} />
      </Actions>
    );
  }

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
  // The API allows it on an item kept for reference, but there it would leave a row with nothing in it: Delete does that whole.
  const canDeleteRaw = file !== null && file.canDeleteRaw && file.rawAvailable && !isReference(item);
  return (
    <View style={styles.actions}>
      {(canRaw || canClean) && !CAN_SAVE_FILES ? <Small>{DATA.nativeDownload}</Small> : null}
      <Actions>
        {open}
        {item.canTurnOff ? (
          <Button variant="link" label={action} accessibilityLabel={named(action)} disabled={props.toggling} onPress={() => { props.onToggle(item); }} />
        ) : null}
        {canRaw && CAN_SAVE_FILES ? (
          <Button
            variant="link"
            label={saving === 'raw' ? FILE_COPY.downloading : DATA.downloadRaw}
            accessibilityLabel={named(DATA.downloadRaw)}
            disabled={saving !== null}
            onPress={() => { save('raw'); }}
          />
        ) : null}
        {canClean && CAN_SAVE_FILES ? (
          <Button
            variant="link"
            label={saving === 'clean' ? FILE_COPY.downloading : DATA.downloadClean}
            accessibilityLabel={named(DATA.downloadClean)}
            disabled={saving !== null}
            onPress={() => { save('clean'); }}
          />
        ) : null}
        {canDeleteRaw ? (
          <Button
            variant="link"
            label={DATA.deleteOriginal}
            accessibilityLabel={named(DATA.deleteOriginal)}
            onPress={() => { props.onConfirm({ kind: 'raw', item }); }}
          />
        ) : null}
        {item.canDelete ? (
          <Button
            variant="link"
            label={DATA.delete}
            accessibilityLabel={named(DATA.delete)}
            onPress={() => { props.onConfirm({ kind: item.ref.startsWith('u_') ? 'upload' : 'file', item }); }}
          />
        ) : null}
      </Actions>
      {error === null ? null : <Messages live="alert" items={[dataError(error)]} />}
    </View>
  );
}

function ItemCell(props: { item: DataItem }): React.JSX.Element {
  const { item } = props;
  const entries = item.file?.entries ?? null;
  return (
    <View style={styles.cell}>
      <Text style={styles.name}>{shownName(item)}</Text>
      <Text style={styles.note}>{VIA_LINE[item.via]}</Text>
      {/* Deleted by a person or by retention. An item kept for reference has no cleaned copy or days to keep. */}
      {item.file === null || item.file.rawAvailable || item.state === 'uploading' || isReference(item) ? null : (
        <Text style={styles.note}>{FILE_COPY.rawGone}</Text>
      )}
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

/** On or Off, then what Townwise did and, once someone let TownwiseAI read the file, what TownwiseAI did (D34). */
function StatusCell(props: { item: DataItem }): React.JSX.Element {
  const { item } = props;
  const ai = rowAiLine(item.ai);
  return (
    <View style={styles.cell}>
      <Text style={styles.value}>{item.enabled ? DATA.on : DATA.off}</Text>
      <Text style={styles.note}>{ai === null ? stateLine(item) : `${stateLine(item)} · ${ai}`}</Text>
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
  ordering: { gap: theme.space[1] },
});
