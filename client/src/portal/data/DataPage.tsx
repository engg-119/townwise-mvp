import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { useLoad } from '../hooks';
import { listFiles, removeOriginals } from '../files/api';
import { COPY as FILE_COPY, deleteAllRawBody, deletedOriginalsLine } from '../files/copy';
import { shownLocationName } from '../locations/naming';
import { LoadFailure, UploadAction, useOrgRefreshOnLeave } from '../locations/parts';
import { CAN_DROP } from '../onboarding/HistoryStepDrop';
import { noticeShowsAt, usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, Messages, Notice, ReadOnlyLine } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Select } from '../ui/Select';
import { Lead, Small } from '../ui/text';
import { AddFile } from './AddFile';
import { listData, type DataCalendar, type DataItem } from './api';
import { DATA, dataError, empty, isReference, lead, tableLabel } from './copy';
import { DataList, DataListSkeleton } from './DataList';
import { useDataView } from './dataView';
import { entriesOf } from './folders';
import { ImportCalendar } from './ImportCalendar';
import { PasteText } from './PasteText';
import { ViewSwitch } from './ViewSwitch';

// P26 Your data (D28), /locations/[locationId]/data: every upload, stored file and calendar a location received, with
// what Townwise did with it, in one list (DataList.tsx, D61): "Organized" in folders by default, or "Newest first", the
// person's pick of View (ViewSwitch.tsx) remembered per signed-in person (dataView.ts). A calendar is an item of the
// Calendars folder, and a stored file imported as one shows once, as the calendar (the API leaves the file out). A row
// opens the item's own page (P27, ItemPage.tsx), or the calendar's (`c_<id>`), from a press anywhere on it, its name
// being the row's one link (DataTable's RowLink); an item still uploading has nothing to open, so its row is not linked.
// Turn off or on, the downloads and the deletes are on the item's page. Opening is a read, so rows stay linked under
// view-as, where the API sends no names: the rows show kinds and dates. “Show” widens the list to every location.
// Stored files off (503) hides Add a file and Paste text; uploads and calendars still list. Org admins also get "Delete
// all originals for this location" (one location shown, a sales file's original stored), which leaves reference items
// whole; it takes its opener away, so focus moves to the line that says how it ended (MessageFocus, as Your files
// did), and it changes what the location holds, so the organization (GET /api/org) is read again when the page closes.
// Opened with a page notice meant for it that hasn't shown yet (an item's page deleted the item and came back here), it
// gives that notice focus, since the control that had focus went with the item's page.
// Item sales, the ordering setup and counts are not listed here; one line points to Ordering setup. "Import a calendar
// file" (ImportCalendar.tsx, D60) sits at the top of the list, and an import reads the list fresh; a calendar file added
// with Add a file becomes a calendar by itself (D60), which the list's next fresh read shows.

const READ_ONLY_ID = 'data-ro';
const ALL = 'all';

export function DataPage(): React.JSX.Element {
  const { notice } = usePortal();
  const pathname = usePathname();
  // Read once, on arrival: the notice is marked shown as it first renders.
  const [arrived] = useState(() => notice !== null && notice.shownAt === null && noticeShowsAt(notice.where, pathname));
  // The location layout's MessageFocus, which holds its page notice; Data's own is inside.
  const focusNotice = useFocusMessage();
  useEffect(() => { if (arrived) focusNotice(); }, [arrived, focusNotice]);
  return <MessageFocus><Data /></MessageFocus>;
}

function Data(): React.JSX.Element {
  const { api, me } = usePortal();
  const [view, setView] = useDataView(me.user.id);
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
  const [shown, setShown] = useState<{ scope: string; items: DataItem[]; next: string | null; calendars: DataCalendar[] } | null>(null);
  if (state.status === 'ready' && state.data.scope === scope && (shown?.scope !== scope || shown.items !== state.data.page.items)) {
    setShown({ scope, items: state.data.page.items, next: state.data.page.next, calendars: state.data.page.calendars });
  }
  const [older, setOlder] = useState<{ items: DataItem[]; next: string | null | undefined; pending: boolean; error: unknown }>({
    items: [], next: undefined, pending: false, error: null,
  });
  // The location whose originals "Delete all originals" is asking to delete.
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
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
    reload();
  }, [reload]);

  // A failed load (the first, after Show changed, or again after a write) shows in place of the list, with Try
  // again; the rest of the page stays, so Show can still switch back. Rows from before are not kept: they may be stale.
  const loadError = state.status === 'failed' ? state.error : null;
  const kept = loadError === null && shown?.scope === scope ? shown : null;
  const first = state.status === 'ready' && state.data.scope === scope ? state.data.page.items : kept?.items ?? null;
  const firstNext = state.status === 'ready' && state.data.scope === scope ? state.data.page.next : kept?.next ?? null;
  const calendars = state.status === 'ready' && state.data.scope === scope ? state.data.page.calendars : kept?.calendars ?? [];

  const items = first === null ? null : [...first, ...older.items];
  const next = older.next === undefined ? firstNext : older.next;
  // Newest first holds back a calendar older than the items loaded until its page loads (folders.ts).
  const entries = items === null ? null : entriesOf(items, calendars, view === 'newest' && next !== null);

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
    removeOriginals(api, confirm).then((result) => { done(deletedOriginalsLine(result)); }, failed);
  };

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
            onChange={(value) => { setShowAll(value === ALL); setOlder({ items: [], next: undefined, pending: false, error: null }); }}
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
              onPress={() => { setConfirm(location.id); }}
            />
          </Actions>
        ) : null}
        {/* At the top of the list (D60, D61); stored files on or off. */}
        <ImportCalendar locationId={location.id} readOnlyId={readOnlyId} onAdded={fresh} />
        <ViewSwitch value={view} onChange={setView} />
        {loadError !== null ? <LoadFailure error={loadError} onRetry={reload} /> : entries === null ? (
          <DataListSkeleton view={view} all={all} label={DATA.loading} />
        ) : entries.length === 0 ? (
          <EmptyState text={empty(all ? DATA.allLocations.toLowerCase() : locationName)} />
        ) : (
          <DataList view={view} entries={entries} all={all} nameOf={nameOf} label={tableLabel(all ? null : locationName)} more={next !== null} />
        )}
        {older.error === null ? null : <Messages live="alert" items={[dataError(older.error)]} />}
        {next === null || entries === null || entries.length === 0 ? null : (
          <Button variant="link" label={older.pending ? DATA.loadingMore : DATA.more} disabled={older.pending} onPress={showOlder} />
        )}
      </Stack>
      <ConfirmDialog
        visible={confirm !== null}
        title={FILE_COPY.deleteAllRaw}
        body={confirm === null ? '' : deleteAllRawBody(nameOf(confirm))}
        confirmLabel={FILE_COPY.deleteAllRaw}
        pendingLabel={DATA.deleting}
        pending={pending}
        onConfirm={run}
        onCancel={() => { setConfirm(null); }}
      />
    </Section>
  );
}

const styles = StyleSheet.create({
  ordering: { gap: theme.space[1] },
});
