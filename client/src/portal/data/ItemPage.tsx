import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, usePathname, useRouter } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { theme } from '../../theme';
import { hasCode } from '../errors';
import { downloadClean, downloadRaw, removeRaw } from '../files/api';
import { cleanName, COPY as FILE_COPY, deleteRawBody } from '../files/copy';
import { CAN_SAVE_FILES, saveFile } from '../files/download';
import { useLoad } from '../hooks';
import { shownLocationName } from '../locations/naming';
import { useOrgRefreshOnLeave } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { calendarHref, itemHref, locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, InlineNotice, LoadingLine, Messages, Notice, ReadOnlyLine, useNoticeState, type NoticeState } from '../ui/feedback';
import { Section, Stack } from '../ui/layout';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Small } from '../ui/text';
import { AI } from './aiCopy';
import { getItem, isCalendarFile, removeItem, setEnabled, type DataItem } from './api';
import {
  DATA, dataError, deletedFileLine, deletedUploadLine, deleteFileBody, deleteUploadBody, isReference, itemName, shownName, turnedOffLine,
  turnedOnLine,
} from './copy';
import { AiSection } from './item/AiSection';
import { CalendarImport } from './item/CalendarImport';
import { CalendarItem } from './item/CalendarItem';
import { addedByLine, EDIT, editedLine, ITEM, itemDaysLine, kindLine, renamedLine, statusLine, tooBigToEditLine } from './item/copy';
import type { Editable, Saved } from './item/edit';
import { ItemContent } from './item/ItemContent';
import { RenameForm } from './item/RenameForm';

// P27 One item of Your data (D28), /locations/[locationId]/data/[ref], inside the location layout: the item's name,
// what it is and how it arrived, who added it and when (and who last edited it), whether it is on, its days, the
// actions the person may take, and what it holds (item/ItemContent: an upload's days on every platform, and on web a
// stored file drawn in the browser). An item that is gone (deleted, or replaced by an edit, whose ref changed) says
// so, with the way back. Opening is a read, so it works under view-as, which sends no name and opens no file; there
// Turn off and Delete are disabled in place under the read-only line, as Your data's rows once had them. A file kept
// as a calendar export (D58, `calendar_export`) links under its status to the Calendar, where Your calendars imports it.
// A calendar file kept for reference says under its status what importing it as a calendar did (D60,
// item/CalendarImport.tsx).
//
// The actions Your data's rows used to carry are here (the list's rows only open this page): Turn off or on (acts at
// once), the downloads (web), then, in a Delete section of their own below the item, as Sales data's Delete sales
// data stands apart, Delete original (a sales file's, not an item kept for reference, which is its original) and
// Delete, each delete saying in words what goes and what stays. Opening a delete's dialog clears the last action's
// notice. Turning an item off or on and deleting one change the location's day counts, so the organization
// (GET /api/org) is read again when the page closes. A delete takes the page away: it goes back to Your data (to the
// entry that opened the item when there is one, so Back never lands on the deleted item nor on Your data twice), which
// says how it ended (PortalProvider.showNotice, shown by the location layout's PageNotice), and that notice takes
// focus (DataPage). A delete that failed stays here and says why; the item is read again, so one that is gone says so.
//
// Editing (web, `item.canEdit`: an item kept for reference, for the person who added it or an org admin): Rename opens
// an inline form (item/RenameForm), and Edit, shown once what opened can be edited (item/edit.ts), puts the editor in
// the viewer's place; one that is too big says why instead. A calendar file whose import found a calendar has no
// `canEdit` (item 144: an edit would import a second calendar) and says how to change it instead. While a rename or a
// save runs, the other actions wait. A
// saved edit lands on the edited item's new ref, or on the copy, with `?saved=` in the address; the page reads that
// once into its own state, says “Saved.” there and drops it from the address, so a reload doesn't say it again.
// Focus moves to the line that says how an action ended (MessageFocus), since each one takes its opener away.
//
// TownwiseAI (D34, item/AiSection): an item with a stored file offers a TownwiseAI read, shows it while it runs and
// what it found and added once done, with Undo; an upload or a summary TownwiseAI made links to its file.
//
// A ref `c_<calendarId>` is one of the location's calendars (D49): item/CalendarItem.tsx, which reads the calendar
// routes, never GET .../data/:ref.

/** One action in the item's header. */
interface ItemAction {
  key: string;
  label: string;
  accessibilityLabel: string;
  disabled: boolean;
  onPress: () => void;
  describedBy?: string;
}

const READ_ONLY_ID = 'item-ro';

/** What a delete on this page is asking to delete: the upload, the stored file, or a sales file's original. */
type Confirm = 'upload' | 'file' | 'raw';

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

/** An action's answer with the events already shown, while both are the same item's done read (a PATCH leaves them out). */
function keepEvents(before: DataItem | null, next: DataItem): DataItem {
  const events = before?.ai?.events;
  if (before?.ref !== next.ref || before.ai?.status !== 'done' || events === undefined) return next;
  if (next.ai?.status !== 'done' || next.ai.events !== undefined) return next;
  return { ...next, ai: { ...next.ai, events } };
}

export function ItemPage(): React.JSX.Element {
  const ref = refOf(usePathname());
  // A calendar's page (D49): a client-only ref, which never reads the data item route.
  if (ref.startsWith('c_')) return <CalendarItem calendarId={ref.slice(2)} />;
  return <MessageFocus><ItemOfPath /></MessageFocus>;
}

function ItemOfPath(): React.JSX.Element {
  const { api, showNotice } = usePortal();
  const { location } = useLocation();
  const { readOnly } = useReadOnly();
  const markStale = useOrgRefreshOnLeave();
  const router = useRouter();
  const ref = refOf(usePathname());
  const params = useLocalSearchParams<{ saved?: string }>();
  // How the save that opened this page ended, read once: the address loses it below.
  // One object for the arrival (Notice's `result`): the item drawing again, as after a failed reload and Try again,
  // never toasts it twice.
  const [saved] = useState<NoticeState | null>(() => {
    const text = savedLine(params.saved);
    return text === null ? null : { text, stays: false };
  });
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
  // An action's answer, shown while the item is read again. The answer leaves out a read's events (only the single
  // item's read carries `ai.events`, D49), so a still-done read keeps the ones on screen until the read lands.
  const showItem = useCallback((next: DataItem) => {
    setShown((before) => keepEvents(before, next));
    reload();
  }, [reload]);
  const dataHref = locationHref(location.id, 'data');
  const back = <LinkButton variant="link" href={dataHref} label={ITEM.back} />;
  // A deleted item has no page: back to Your data, which says how it ended. dismissTo pops back to the Your data that
  // opened it, or puts Your data in its place when none did.
  const deleted = useCallback((text: string) => {
    showNotice({ text }, dataHref);
    router.dismissTo(dataHref);
  }, [showNotice, dataHref, router]);

  if (state.status === 'failed') {
    return (
      <Section>
        {hasCode(state.error, 404, 'not_found') ? <InlineNotice text={ITEM.gone} /> : <ErrorNotice message={dataError(state.error)} onRetry={reload} />}
        {back}
      </Section>
    );
  }
  if (item === null) return <Section><LoadingLine text={ITEM.loading} /></Section>;
  return (
    <Item
      item={item} viewAs={readOnly} back={back} reload={reload} showItem={showItem} openRef={openRef} saved={saved} markStale={markStale}
      deleted={deleted}
    />
  );
}

function Item(props: {
  item: DataItem;
  viewAs: boolean;
  back: React.ReactNode;
  reload: () => void;
  /** Shows an action's answer, then reads the item again. */
  showItem: (item: DataItem) => void;
  openRef: (ref: string, saved?: Saved) => void;
  /** “Saved.” when a save opened this page. */
  saved: NoticeState | null;
  /** Reads the organization again once the page closes: the item's days changed. */
  markStale: () => void;
  /** Leaves the page after a delete, saying `text` on Your data. */
  deleted: (text: string) => void;
}): React.JSX.Element {
  const { item, saved, markStale } = props;
  const { api } = usePortal();
  const { location, org } = useLocation();
  const { line } = useReadOnly();
  const [saving, setSaving] = useState<'raw' | 'clean' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [mode, setMode] = useState<'rename' | 'edit' | null>(null);
  // What opened can be edited (FileView reports it), and a rename or an edit being saved.
  const [editable, setEditable] = useState<Editable | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useNoticeState(saved);
  // A Turn off or on running, and the delete being asked about or run.
  const [toggling, setToggling] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [pending, setPending] = useState(false);
  const focusMessage = useFocusMessage();
  useEffect(() => { if (saved !== null) focusMessage(); }, [saved, focusMessage]);
  // Asked one update after a dialog closes: in that update its focus trap still holds focus.
  const [ended, setEnded] = useState(0);
  useEffect(() => { if (ended > 0) focusMessage(); }, [ended, focusMessage]);
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
  const toggle = (): void => {
    if (toggling) return;
    const enable = !item.enabled;
    setToggling(true);
    setNotice(null);
    setError(null);
    setEnabled(api, item.locationId, item.ref, enable).then(
      (updated) => {
        markStale();
        setToggling(false);
        setNotice(enable ? turnedOnLine(itemName(item)) : turnedOffLine(itemName(item), shownLocationName(location, org)));
        focusMessage();
        props.showItem(updated);
      },
      (caught: unknown) => {
        setToggling(false);
        setError(caught);
        if (caught instanceof ApiError && caught.kind === 'http' && caught.status === 404) props.reload();
      },
    );
  };
  const run = (): void => {
    if (confirm === null || pending) return;
    setPending(true);
    setNotice(null);
    setError(null);
    // The delete may have taken effect even so (a lost answer), so the organization is read again too.
    const failed = (caught: unknown): void => {
      markStale();
      setPending(false);
      setConfirm(null);
      setError(caught);
      setEnded((n) => n + 1);
      props.reload();
    };
    if (confirm === 'raw') {
      if (file === null) return;
      removeRaw(api, item.locationId, file.id).then(() => {
        markStale();
        setPending(false);
        setConfirm(null);
        setNotice(FILE_COPY.rawDeleted);
        setEnded((n) => n + 1);
        props.reload();
      }, failed);
      return;
    }
    removeItem(api, item.locationId, item.ref).then((result) => {
      markStale();
      props.deleted(confirm === 'upload' ? deletedUploadLine(result.deletedDays) : deletedFileLine(itemName(item)));
    }, failed);
  };
  // A delete's dialog starts without the last action's notice, which would otherwise show behind it and after it.
  const ask = (which: Confirm): void => {
    setNotice(null);
    setConfirm(which);
  };
  const open = (next: 'rename' | 'edit'): void => {
    setNotice(null);
    setError(null);
    setMode(next);
  };

  const canRaw = file !== null && file.canDownloadRaw && file.rawAvailable;
  const canClean = file !== null && file.canDownloadClean && file.hasClean;
  // The API allows it on an item kept for reference, but there it would leave an item with nothing in it: Delete does that whole.
  const canDeleteRaw = file !== null && file.canDeleteRaw && file.rawAvailable && !isReference(item);
  // A write waits for any other write here; under view-as Turn off and Delete show, disabled under the read-only line.
  const writing = busy || toggling || pending;
  const readOnly = props.viewAs ? { disabled: true, describedBy: READ_ONLY_ID } : null;
  const turn = item.enabled ? DATA.turnOff : DATA.turnOn;
  const actions: ItemAction[] = [];
  // Delete original and Delete, in their own section below the item.
  const deletes: ItemAction[] = [];
  if (editing && mode === null) {
    if (editable?.fits === true) {
      actions.push({ key: 'edit', label: EDIT.edit, accessibilityLabel: named(EDIT.edit), disabled: writing, onPress: () => { open('edit'); } });
    }
    actions.push({ key: 'rename', label: EDIT.rename, accessibilityLabel: named(EDIT.rename), disabled: writing, onPress: () => { open('rename'); } });
  }
  if (item.canTurnOff || readOnly !== null) {
    actions.push({ key: 'turn', label: turn, accessibilityLabel: named(turn), disabled: writing, onPress: toggle, ...readOnly });
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
  if (canDeleteRaw) {
    deletes.push({
      key: 'deleteRaw', label: DATA.deleteOriginal, accessibilityLabel: named(DATA.deleteOriginal), disabled: writing,
      onPress: () => { ask('raw'); },
    });
  }
  if (item.canDelete || readOnly !== null) {
    deletes.push({
      key: 'delete', label: DATA.delete, accessibilityLabel: named(DATA.delete), disabled: writing,
      onPress: () => { ask(item.ref.startsWith('u_') ? 'upload' : 'file'); }, ...readOnly,
    });
  }
  const dialog = confirm === null ? null : dialogOf(confirm, item, shownLocationName(location, org));
  const edited = editedLine(item);
  const days = itemDaysLine(item);

  return (
    <Section title={shownName(item)}>
      <Stack>
        {notice === null ? null : <Notice text={notice.text} result={notice} />}
        {props.back}
        <View style={styles.lines}>
          <Small>{kindLine(item)}</Small>
          <Small>{addedByLine(item)}</Small>
          {edited === null ? null : <Small>{edited}</Small>}
          <Small>{statusLine(item)}</Small>
          {days === null ? null : <Small>{days}</Small>}
        </View>
        {item.state === 'kept' && item.outcome === 'calendar_export'
          ? <LinkButton variant="link" href={calendarHref(item.locationId)} label={ITEM.importCalendar} />
          : null}
        <CalendarImport item={item} readOnlyId={props.viewAs ? READ_ONLY_ID : null} showItem={props.showItem} />
        {item.fromAiRead === null ? null : <LinkButton href={itemHref(item.locationId, item.fromAiRead)} label={AI.madeBy} />}
        {props.viewAs ? <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} /> : null}
        {(canRaw || canClean) && !CAN_SAVE_FILES ? <Small>{DATA.nativeDownload}</Small> : null}
        <ActionRow actions={actions} />
        {editing && mode === null && editable?.fits === false ? <Small>{tooBigToEditLine(editable.kind)}</Small> : null}
        {CAN_EDIT && !props.viewAs && item.calendar != null && isCalendarFile(item) ? <Small>{EDIT.calendarFile}</Small> : null}
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
        {mode === 'edit' ? null : <AiSection item={item} showItem={props.showItem} reload={props.reload} />}
        <ItemContent
          item={item}
          viewAs={props.viewAs}
          reload={props.reload}
          openRef={props.openRef}
          edit={{ open: mode === 'edit', onEditable: setEditable, onSaving: setBusy, onClose: () => { setMode(null); } }}
        />
      </Stack>
      {deletes.length === 0 ? null : <Section title={ITEM.deletes}><ActionRow actions={deletes} /></Section>}
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

function ActionRow(props: { actions: readonly ItemAction[] }): React.JSX.Element | null {
  if (props.actions.length === 0) return null;
  return (
    <Actions>
      {props.actions.map((action) => (
        <Button
          key={action.key}
          variant="outline"
          label={action.label}
          accessibilityLabel={action.accessibilityLabel}
          disabled={action.disabled}
          {...(action.describedBy === undefined ? {} : { describedBy: action.describedBy })}
          onPress={action.onPress}
        />
      ))}
    </Actions>
  );
}

function dialogOf(confirm: Confirm, item: DataItem, locationName: string): { title: string; body: string; label: string } {
  switch (confirm) {
    case 'upload':
      return { title: DATA.deleteUploadTitle, body: deleteUploadBody(item, locationName), label: DATA.deleteUploadConfirm };
    case 'file':
      return { title: DATA.deleteFileTitle, body: deleteFileBody(itemName(item)), label: DATA.deleteFileConfirm };
    case 'raw':
      return {
        title: FILE_COPY.deleteRaw,
        body: deleteRawBody({ name: item.name, kind: item.kind === 'daily_totals' ? 'other' : item.kind, uploadedAt: item.addedAt }),
        label: FILE_COPY.deleteRaw,
      };
  }
}

const styles = StyleSheet.create({
  lines: { gap: theme.space[1] },
});
