import { useCallback, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { useAction } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, Messages, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Popover } from '../ui/Popover';
import { Mono, Small } from '../ui/text';
import { addOwnerCalendar, refreshOwnerCalendar, removeOwnerCalendar, type OwnerCalendar } from './api';
import {
  addedLines, addRefusal, CALENDARS_COPY, labelOfFile, linkProblems, refreshedLine, refreshRefusal, removedLine, rowLines, statusWords,
} from './calendars';
import { IcsImport } from './IcsImport';

// "Your calendars" (P28, spec 16.3 and 17, D33 and D40; connect-owner-calendar design decision 11, refine-calendar-and-home
// design decision 1), one file for web and native: the header row's last control, which Toolbar's `trailing` places,
// and the popover it opens. The button reads "Your calendars (N)", N the location's calendar count, or "Your calendars"
// with none or when the list couldn't be read. It opens a popover (ui/Popover.tsx, at most 440px wide) anchored to it,
// so nothing under the header row moves: aria-expanded and aria-haspopup="dialog" on web, with aria-controls naming the
// popover only while it is open, and an expanded state on native; closed on every load. The popover is headed "Your
// calendars" with a "Close" text button, which takes focus as it opens; closing it (Close, Escape, Android's back button
// or a press outside) gives focus back to the button. Top to bottom: the list (`role="list"`, oldest first: each row's
// name, kind and count, repeating events left out, and for a link its status in words and its "Updated" time, then
// "Refresh now" for a link and "Remove"; "No calendars yet." with none; "Couldn't load your calendars." with Try again,
// which reads the list and the grid's stored events again, when the list couldn't be read), the messages line (results
// as status, refusals as alerts), the import (IcsImport: the file picker on web, native's line pointing to it) and "Add
// a link", which the add-a-link form replaces while it is open, then "How importing works" with its help, mounted while
// hidden and describing the import, and under view-as the popover's own read-only line. A chosen file is posted as
// `{ kind: 'file', label, ics }` (the label from its name, labelOfFile), with "Importing…" meanwhile, and a link as
// `{ kind: 'link', label, url }` with "Adding…" while the API fetches it; on a 201 the page reads the list and the
// grid's stored events again and turns "Your calendar" on (`onChanged(true)`). "Refresh now" (a 200, whatever its
// status) and "Remove" (after "Remove this calendar?", a 204) read them again too (`onChanged(false)`), as a 404 on
// either does ("This calendar was already removed."); nothing else reads again, and never the forecast, which stored
// events change only through notes. Any other refusal stores nothing and reads nothing again. While the list reads
// again (`reading`) a row may be out of date, a removed calendar still listed, so every row's Refresh now and Remove
// wait, disabled in place, and the list is aria-busy. While a link add, a file import or a Refresh now runs the popover
// waits for its answer (Popover's `busy`: Close disabled in place, Escape, back and a press outside doing nothing), and
// a press outside never closes it while its Remove dialog is open, so every answer lands in the open popover. The
// popover's content unmounts when it closes, so what must survive closing lives here, in Calendars, which stays mounted
// with the button: the messages line, the help's open state, whether the add-a-link form is open, its Name and Calendar
// link fields and their problems, and the link add itself (its pending state and its in-flight guard, so no remount can
// post a link twice). When the popover takes away the control that has focus, focus moves to what takes its place, as
// on Rules: "Add a link" opens the form with focus in Name, and Cancel gives it back to "Add a link" (on native the
// screen reader's, places/focus.ts); an add that worked, a Remove (once its dialog has given focus back to its opener)
// and a 404 on Refresh now move it to the messages line (MessageFocus, around the popover), since each takes its control
// away. Under view-as the list and the help work and every write stays in place, disabled, described by the read-only
// line. The same component on native, where the import is IcsImport.tsx's line.
// [CONFIRM: the import help behind "How importing works"]

const POPOVER_ID = 'your-calendars';
const HELP_ID = 'your-calendars-help';
const READ_ONLY_ID = 'your-calendars-ro';

export interface YourCalendarsProps {
  /** The location's calendars, oldest first; null before the list's first answer. */
  calendars: OwnerCalendar[] | null;
  /** The list's last read failed. */
  failed: boolean;
  /** The list is reading again: its rows may be out of date, so their actions wait. */
  reading: boolean;
  /** Reads the list and the grid's stored events again. */
  onRetry: () => void;
  /** After a calendar is added (`added`), refreshed or removed: the page reads the list and the stored events again. */
  onChanged: (added: boolean) => void;
}

/** The messages line: what the popover's last import, add, refresh or removal did, or why it was refused. */
type Message = { live: 'status' | 'alert'; items: string[] } | null;

/** Under view-as, how a write control stays in place: disabled, described by the popover's read-only line. */
type ReadOnlyProps = { disabled: true; describedBy: string } | null;

/** The add-a-link form's checks that failed, by field. */
interface LinkProblems {
  name?: string;
  link?: string;
}

/**
 * The add-a-link form: closed; opened by "Add a link", when Name takes focus as it mounts; open, when it shows again as
 * the popover opens with focus on Close; or closed by its Cancel, when "Add a link" comes back with focus.
 */
type LinkForm = 'closed' | 'opening' | 'open' | 'cancelled';

/**
 * A calendar in the list: its name, "File, 12 events" or "Link, calendar.google.com, 1 event", the repeating events it
 * left out, and for a link its status in words (none when `ok`) before the time of its last refresh that worked; then
 * "Refresh now" (a link only; "Refreshing…" while it runs, and every row's disabled meanwhile) and "Remove" (disabled
 * while its own row refreshes, so the refresh can't answer 404 for a calendar the popover has just removed).
 */
function CalendarRow(props: {
  calendar: OwnerCalendar;
  /** This row's refresh runs. */
  refreshing: boolean;
  /** Any row's refresh runs: one at a time. */
  refreshBusy: boolean;
  /** The list is reading again. */
  reading: boolean;
  ro: ReadOnlyProps;
  onRefresh: (calendar: OwnerCalendar) => void;
  onRemove: (calendar: OwnerCalendar) => void;
}): React.JSX.Element {
  const { calendar, ro } = props;
  const row = rowLines(calendar);
  const status = calendar.kind === 'link' ? statusWords(calendar.status) : null;
  return (
    <View role="listitem" style={styles.row}>
      <Small white>{calendar.label}</Small>
      <Mono>{row.summary}</Mono>
      {row.repeating === null ? null : <Small>{row.repeating}</Small>}
      {status === null ? null : <Small white>{status}</Small>}
      {row.updated === null ? null : <Mono>{row.updated}</Mono>}
      <Actions>
        {calendar.kind === 'link' ? (
          <Button
            variant="link"
            label={props.refreshing ? 'Refreshing…' : 'Refresh now'}
            accessibilityLabel={`${props.refreshing ? 'Refreshing…' : 'Refresh now'}: ${calendar.label}`}
            {...(ro ?? { disabled: props.refreshBusy || props.reading })}
            onPress={() => { props.onRefresh(calendar); }}
          />
        ) : null}
        <Button
          variant="link"
          label="Remove"
          accessibilityLabel={`Remove ${calendar.label}`}
          {...(ro ?? { disabled: props.reading || props.refreshing })}
          onPress={() => { props.onRemove(calendar); }}
        />
      </Actions>
    </View>
  );
}

/**
 * The add-a-link form, in place of "Add a link" while open: Name and Calendar link, then "Add link", which reads
 * "Adding…" while the API fetches the link, and Cancel. Its fields and the add live in Calendars, so closing the popover
 * keeps what was typed. Name takes focus only when "Add a link" opened it (`focusName`), since "Add a link" is gone.
 */
function AddLink(props: {
  name: string;
  link: string;
  problems: LinkProblems;
  /** The add is out: both actions wait, disabled in place. */
  pending: boolean;
  focusName: boolean;
  onName: (name: string) => void;
  onLink: (link: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { problems } = props;
  return (
    <View style={styles.form}>
      <FormField
        label={CALENDARS_COPY.nameLabel}
        helper={CALENDARS_COPY.nameHelper}
        value={props.name}
        onChangeText={props.onName}
        autoFocus={props.focusName}
        autoCapitalize="words"
        autoCorrect={false}
        messages={problems.name === undefined ? [] : [problems.name]}
      />
      <FormField
        label={CALENDARS_COPY.linkLabel}
        helper={CALENDARS_COPY.linkHelper}
        value={props.link}
        onChangeText={props.onLink}
        onSubmitEditing={props.onSubmit}
        keyboardType="url"
        autoComplete="off"
        autoCorrect={false}
        messages={problems.link === undefined ? [] : [problems.link]}
      />
      <Actions>
        <Button variant="outline" label={props.pending ? 'Adding…' : 'Add link'} disabled={props.pending} onPress={props.onSubmit} />
        <Button variant="link" label="Cancel" disabled={props.pending} onPress={props.onCancel} />
      </Actions>
    </View>
  );
}

export function YourCalendars(props: YourCalendarsProps): React.JSX.Element {
  return <MessageFocus><Calendars {...props} /></MessageFocus>;
}

function Calendars(props: YourCalendarsProps): React.JSX.Element {
  const { onChanged } = props;
  const { api } = usePortal();
  const { location } = useLocation();
  const { readOnly, line } = useReadOnly();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const ro: ReadOnlyProps = readOnlyId === null ? null : { disabled: true, describedBy: readOnlyId };
  const [open, setOpen] = useState(false);
  // The opener, which the popover is anchored to.
  const anchor = useRef<React.ComponentRef<typeof View>>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [form, setForm] = useState<LinkForm>('closed');
  const adding = form === 'opening' || form === 'open';
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [problems, setProblems] = useState<LinkProblems>({});
  // Every answer lands while the popover is open (it waits while an add, an import or a refresh runs), so focus is
  // always in it when the messages line asks for it.
  const focusMessage = useFocusMessage();
  // Remove took its row away (or found it gone): once the dialog has closed, the messages line takes focus.
  const removeEnded = useRef(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OwnerCalendar | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const list = props.failed ? null : props.calendars;
  const count = list === null ? 0 : list.length;
  const platform = Platform.OS === 'web' ? 'web' : 'native';

  const importFile = useAction(useCallback(async (file: { name: string; text: string }) => {
    setMessage(null);
    let added: OwnerCalendar;
    try {
      added = await addOwnerCalendar(api, location.id, { kind: 'file', label: labelOfFile(file.name), ics: file.text });
    } catch (error) {
      setMessage({ live: 'alert', items: [addRefusal(error, 'file', platform)] });
      return;
    }
    setMessage({ live: 'status', items: addedLines(added) });
    onChanged(true);
  }, [api, location.id, platform, onChanged]));

  const onRefused = useCallback((words: string) => { setMessage({ live: 'alert', items: [words] }); }, []);

  /** Clears the form's fields: the popover's content no longer unmounts with them, and the address is never kept. */
  const clearLink = useCallback(() => {
    setName('');
    setLink('');
    setProblems({});
  }, []);

  // A refusal keeps what was typed; a 201 closes the form and clears it.
  const add = useAction(useCallback(async (body: { label: string; url: string }) => {
    let added: OwnerCalendar;
    try {
      added = await addOwnerCalendar(api, location.id, { kind: 'link', ...body });
    } catch (error) {
      onRefused(addRefusal(error, 'link', platform));
      return;
    }
    setForm('closed');
    clearLink();
    setMessage({ live: 'status', items: addedLines(added) });
    focusMessage();
    onChanged(true);
  }, [api, location.id, platform, onChanged, onRefused, clearLink, focusMessage]));

  /** "Add link": the message clears, whether the fields pass their checks or not, and only fields that pass are sent. */
  function submitLink(): void {
    if (add.pending) return;
    const found = linkProblems({ name, link });
    setProblems(found);
    setMessage(null);
    if (found.name !== undefined || found.link !== undefined) return;
    add.run({ label: name.trim(), url: link.trim() });
  }

  // A 200 is one fetch done: its status says whether it worked, and the list and the stored events read again either
  // way. A 404 (gone in the meantime) reads them again too; any other refusal changed nothing.
  const refresh = useAction(useCallback(async (calendar: OwnerCalendar) => {
    setMessage(null);
    let saved: OwnerCalendar;
    try {
      saved = await refreshOwnerCalendar(api, location.id, calendar.id);
    } catch (error) {
      onRefused(refreshRefusal(error));
      // Gone: the list read again takes its row, and the button with focus, away.
      if (hasCode(error, 404, 'not_found')) {
        focusMessage();
        onChanged(false);
      }
      return;
    }
    const words = statusWords(saved.status);
    setMessage(words === null ? { live: 'status', items: [refreshedLine(calendar.label)] } : { live: 'alert', items: [words] });
    onChanged(false);
  }, [api, location.id, onChanged, onRefused, focusMessage]));

  // Any failure but a 404 shows in the dialog, which stays open.
  const remove = useAction(useCallback(async (calendar: OwnerCalendar) => {
    try {
      await removeOwnerCalendar(api, location.id, calendar.id);
    } catch (error) {
      if (!hasCode(error, 404, 'not_found')) throw error;
      removeEnded.current = true;
      setRemoving(null);
      onRefused(CALENDARS_COPY.alreadyRemoved);
      onChanged(false);
      return;
    }
    removeEnded.current = true;
    setRemoving(null);
    setMessage({ live: 'status', items: [removedLine(calendar.label)] });
    onChanged(false);
  }, [api, location.id, onChanged, onRefused]));

  // An add, an import or a refresh is out: the popover waits for its answer.
  const busy = add.pending || importFile.pending || refresh.pending;
  /** Closes the popover. A form opened or cancelled since it opened shows again with focus on Close. */
  const close = useCallback(() => {
    setOpen(false);
    setForm((current) => (current === 'opening' ? 'open' : current === 'cancelled' ? 'closed' : current));
  }, []);

  return (
    <>
      <Button
        ref={anchor}
        variant="outline"
        label={count === 0 ? 'Your calendars' : `Your calendars (${String(count)})`}
        expanded={open}
        hasPopup="dialog"
        {...(open ? { controls: POPOVER_ID } : {})}
        onPress={() => { setOpen(true); }}
      />
      <Popover
        visible={open}
        anchor={anchor}
        label="Your calendars"
        nativeID={POPOVER_ID}
        maxWidth={440}
        closeButton
        busy={busy}
        dismissOnOutsidePress={removing === null}
        onClose={close}
      >
        {props.failed ? <ErrorNotice message="Couldn’t load your calendars." onRetry={props.onRetry} /> : null}
        {list === null ? null : list.length === 0 ? <Small>{CALENDARS_COPY.none}</Small> : (
          <View role="list" aria-busy={props.reading} style={styles.list}>
            {list.map((calendar) => (
              <CalendarRow
                key={calendar.id}
                calendar={calendar}
                refreshing={refresh.pending && refreshingId === calendar.id}
                refreshBusy={refresh.pending}
                reading={props.reading}
                ro={ro}
                onRefresh={(chosen) => { setRefreshingId(chosen.id); refresh.run(chosen); }}
                onRemove={(chosen) => { removeEnded.current = false; setStaleError(remove.error); setRemoving(chosen); }}
              />
            ))}
          </View>
        )}
        {message === null ? null : <Messages live={message.live} takesFocus items={message.items} />}
        <Actions>
          <IcsImport describedBy={HELP_ID} pending={importFile.pending} readOnlyId={readOnlyId} onFile={importFile.run} onRefusal={onRefused} />
          {adding ? null : (
            <Button variant="outline" label="Add a link" focusOnMount={form === 'cancelled'} {...ro} onPress={() => { setForm('opening'); }} />
          )}
        </Actions>
        {adding ? (
          <AddLink
            name={name}
            link={link}
            problems={problems}
            pending={add.pending}
            focusName={form === 'opening'}
            onName={setName}
            onLink={setLink}
            onSubmit={submitLink}
            onCancel={() => { clearLink(); setForm('cancelled'); }}
          />
        ) : null}
        <Button variant="link" label="How importing works" expanded={helpOpen} controls={HELP_ID} onPress={() => { setHelpOpen((value) => !value); }} />
        <Small nativeID={HELP_ID} style={helpOpen ? null : styles.hidden}>{CALENDARS_COPY.help}</Small>
        {readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />}
        <ConfirmDialog
          visible={removing !== null}
          title="Remove this calendar?"
          body="Its events leave the Calendar. Notes you made from them stay."
          confirmLabel="Remove calendar"
          pendingLabel="Removing…"
          pending={remove.pending}
          error={remove.error === staleError ? null : remove.error}
          onConfirm={() => { if (removing !== null) remove.run(removing); }}
          onCancel={() => { setRemoving(null); }}
          onDismiss={() => {
            if (!removeEnded.current) return;
            removeEnded.current = false;
            focusMessage();
          }}
        />
      </Popover>
    </>
  );
}

const styles = StyleSheet.create({
  list: { gap: theme.space[4] },
  row: { gap: 2, minWidth: 0 },
  form: { gap: theme.space[4] },
  hidden: { display: 'none' },
});
