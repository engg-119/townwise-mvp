import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { useAction } from '../hooks';
import { shownLocationName } from '../locations/naming';
import { usePortal, useReadOnly } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { ids } from '../ui/aria';
import { Actions, Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, Messages, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Popover } from '../ui/Popover';
import { Mono, Small } from '../ui/text';
import {
  addOwnerCalendar, connectGoogleCalendars, dropGoogleConnection, fetchGoogleChoices, refreshOwnerCalendar, removeOwnerCalendar,
  type GoogleCalendars, type GoogleChoice, type OwnerCalendar,
} from './api';
import {
  addedLines, addGoogleLabel, addRefusal, CALENDARS_COPY, GOOGLE_COPY, googleRefusal, helpText, labelOfFile, linkProblems, MAX_CALENDARS,
  pickerLine, refreshable, refreshedLine, refreshRefusal, refusedLine, removedLine, roomLine, rowLines, statusWords, type Reconnect,
} from './calendars';
import { GoogleConnect } from './GoogleConnect';
import { IcsImport } from './IcsImport';

// "Your calendars" (P28, spec 16.3 and 17, D33, D39 and D40; connect-owner-calendar design decision 11,
// refine-calendar-and-home design decision 1, connect-google-calendar design decision 15), one file for web and native:
// the header row's last control, which Toolbar's `trailing` places, and the popover it opens. The button reads "Your
// calendars (N)", N the location's calendar count, or "Your calendars" with none or when the list couldn't be read. It
// opens a popover (ui/Popover.tsx, at most 440px wide) anchored to it, so nothing under the header row moves:
// aria-expanded and aria-haspopup="dialog" on web, with aria-controls naming the popover only while it is open, and an
// expanded state on native; closed on every load. The popover is headed "Your calendars" with a "Close" text button,
// which takes focus as it opens; closing it (Close, Escape, Android's back button or a press outside) gives focus back
// to the button. Top to bottom: the list (`role="list"`, oldest first: each row's name, kind and count, repeating
// events left out, and for a link or a Google calendar its status in words and its "Updated" time, then "Refresh now"
// for a link or a Google calendar, "Reconnect" (below) and "Remove"; a kind the page doesn't know reads "Calendar, {n} events" with "Remove"
// only; "No calendars yet." with none; "Couldn't load your calendars." with Try again, which reads the list and the
// grid's stored events again, when the list couldn't be read), the messages line (results as status, refusals as
// alerts), the import (IcsImport: the file picker on web, native's line pointing to it), "Add a link", which the
// add-a-link form replaces while it is open, and on web, while the list answers `google.available`, "Add a Google
// calendar", which the Google section replaces while it is open; then "How importing works" with its help, mounted
// while hidden and describing the import, and under view-as the popover's own read-only line. The help, and native's
// line in place of the import, name Google calendars only while the list answers them on. A chosen file is posted as
// `{ kind: 'file', label, ics }` (the label from its name, labelOfFile), with "Importing…" meanwhile, and a link as
// `{ kind: 'link', label, url }` with "Adding…" while the API fetches it; on a 201 the page reads the list and the
// grid's stored events again and turns "Your calendar" on (`onChanged(true)`). "Refresh now" (a 200, whatever its
// status) and "Remove" (after "Remove this calendar?", a 204) read them again too (`onChanged(false)`), as a 404 on
// either does ("This calendar was already removed."); nothing else reads again but a Google connect (below), and never
// the forecast, which stored events change only through notes. Any other refusal stores nothing and reads nothing
// again. While the list reads again (`reading`) a row may be out of date, a removed calendar still listed, so every
// row's Refresh now and Remove wait, disabled in place, and the list is aria-busy.
// The Google section (google-calendar's "The Your calendars popover connects and picks Google calendars"): for a person
// the list says is connected it first reads their choices ("Add a Google calendar" reading "Loading your Google
// calendars…" meanwhile, disabled in place), and a 409 google_not_connected or google_reconnect (with "Connect your
// Google account again to add calendars.") falls back to the explainer; for anyone else it opens on the explainer, then
// "Continue to Google", described by the explainer since its press is the agreement, and Cancel (GoogleConnect.web.tsx,
// which loads Google's script only now and opens Google's window in the press). While Google's window is open it says
// "Waiting for Google…" with "Stop waiting"; a code is posted as `{ code, agreed: true }` ("Connecting your Google
// account…"), and the answer's choices open the picker while the list reads again (`onChanged(false)`), so it says the
// person is connected even if they add nothing; any refusal shows the explainer again with its words. The picker
// says "Choose the calendars to add to {location}.", then a checkbox row per calendar (the primary first, with "Your
// main calendar"; one already on the location checked, disabled and "Added"), "This location can add {k} more." with
// the checks capped at k, the line on sharing another account's calendar, and "Add {n} calendars" ("Add calendar" for
// one) and Cancel. The adds are posted one at a time as `{ kind: 'google', googleCalendarId }`, each with its own line
// in the messages line, stopping at a refusal that isn't about that calendar alone; when any was added the section
// closes, the list and the stored events read again once (`onChanged(true)`) and focus moves to the messages line,
// and when none was the picker stays (or, refused as no longer connected, the explainer shows). Cancel after a fresh
// connect with nothing added drops the connection (`DELETE /api/org/google-connection`), whose 404, 409 or failure
// changes nothing here: the API's connection check ends an unused connection a day after its connect. Native never
// offers the section (its line points to the web). Staff (the list's `canConnect` false, under view-as or open as
// admin; owner decision, 2026-11-17) see "Add a Google calendar" in place, disabled, described by the line under the
// actions "Members of this organization connect their own Google calendars. Staff can't connect one." (and under
// view-as by the read-only line too), and pressing it opens nothing.
// Reconnect: a Google calendar Google no longer lets Townwise read (`google_revoked`) says who can mend it. For the
// person who added it (the list's `mine`) on web, while the list answers Google calendars on, its row offers
// "Reconnect", which opens the same section on its explainer, in place of the row's Reconnect and of "Add a Google
// calendar"; a connect started there shows no picker: each of the person's own Google calendars here gets a Refresh
// now, one at a time, while the popover waits, then the section closes, the messages line says "Reconnected to
// Google." (with "Your Google calendars are up to date." when every one was read, or that Townwise reads them within
// 15 minutes when a refresh was refused), focus moves to it, and the list and the stored events read again
// (`onChanged(false)`). Its Cancel gives focus back to that row's Reconnect. Anyone else's row asks them to ask
// whoever added it, and native's, which connects nowhere, tells the person who added it to reconnect on the web. Staff
// never get a Reconnect: the API answers them `mine` false, so they read the words for anyone else, and Reconnect needs
// `canConnect` as the section does.
// While a link add, a file import, a Refresh now, or a Google choices read, wait, connect or add runs the popover waits
// for its answer (Popover's `busy`: Close disabled in place, Escape, back and a press outside doing nothing), and a
// press outside never closes it while its Remove dialog is open, so every answer lands in the open popover. The
// popover's content unmounts when it closes, so what must survive closing lives here, in Calendars, which stays mounted
// with the button: the messages line, the help's open state, whether the add-a-link form is open, its Name and Calendar
// link fields and their problems, and the link add itself (its pending state and its in-flight guard, so no remount
// can post a link twice); and the Google section's step, its choices and checks, the `state` Google's answer must
// carry, and its connect and adds. When the popover takes away the control that has focus, focus moves to what takes
// its place, as on Rules: "Add a link" opens the form with focus in Name, and Cancel gives it back to "Add a link" (on
// native the screen reader's, places/focus.ts); "Add a Google calendar" opens the section with focus on "Continue to
// Google" (or keeps it, disabled in place, while a connected person's choices are read, and the picker's first control
// takes it once they arrive), "Stop waiting" takes it while Google's window is open, keeps it, disabled in place, while
// the code is posted, and gives it back to "Continue to Google", and the section's Cancel gives it back to "Add a
// Google calendar"; an add that worked, Google calendars added from the picker, a Remove (once its dialog has given
// focus back to its opener) and a 404 on Refresh now move it to the messages line (MessageFocus, around the popover),
// since each takes its control away. A part of the Google section that shows again as the popover opens takes no focus,
// which stays on Close. Under view-as the list and the help work and every write stays in place, disabled, described by
// the read-only line. The same component on native, where the import is IcsImport.tsx's line.
// [CONFIRM: the import help behind "How importing works"]

const POPOVER_ID = 'your-calendars';
const HELP_ID = 'your-calendars-help';
const READ_ONLY_ID = 'your-calendars-ro';
/** The picker rows' second lines, by row. */
const GOOGLE_CHOICE_ID = 'your-calendars-google';
/** The explainer, which describes "Continue to Google": its press is the person's agreement. */
const EXPLAINER_ID = 'your-calendars-google-explainer';
/** The line that tells staff they can't connect, which describes "Add a Google calendar" disabled in place. */
const STAFF_ID = 'your-calendars-google-staff';

export interface YourCalendarsProps {
  /** The location's calendars, oldest first; null before the list's first answer. */
  calendars: OwnerCalendar[] | null;
  /** The list's `google`: whether Google calendars are on, whether the person is connected, and the client id. */
  google: GoogleCalendars;
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
 * The Google section's step: closed ("Add a Google calendar" in its place); reading a connected person's choices;
 * the explainer; Google's window open; the code being posted; the picker; or its adds being posted.
 */
type GoogleStep = 'closed' | 'loading' | 'explaining' | 'waiting' | 'connecting' | 'picking' | 'adding';

/**
 * What takes focus as the Google section's next part mounts: "Continue to Google", the picker's first control, or "Add
 * a Google calendar" coming back; null after the popover opens, so a part that shows as it opens leaves focus on Close.
 */
type GoogleFocus = 'continue' | 'picker' | 'add' | 'reconnect' | null;

/** A refusal about the one calendar it was for: the next add of a batch may still work. */
function aboutOneCalendar(error: unknown): boolean {
  return hasCode(error, 409, 'calendar_already_added') || hasCode(error, 400, 'google_not_found') || hasCode(error, 400, 'google_forbidden');
}

/** A refusal that says the person's Google connection is gone or dead: the explainer again. */
function connectionGone(error: unknown): boolean {
  return hasCode(error, 409, 'google_not_connected') || hasCode(error, 409, 'google_reconnect');
}

/** Who can mend a calendar Google no longer lets Townwise read, from this popover; no one while Google is off. */
function reconnectOf(calendar: OwnerCalendar, googleOn: boolean): Reconnect {
  if (!googleOn) return 'none';
  if (!calendar.mine) return 'other';
  return Platform.OS === 'web' ? 'here' : 'web';
}

/** A control in the tab order: react-native-web draws a pressable as a <button> or with tabindex 0. */
const CONTROL = 'input, button, [tabindex="0"]';

/** On web, focus to the first control inside the returned view as it mounts, when `enabled` was true then. */
function useFocusFirstControl(enabled: boolean): RefObject<React.ComponentRef<typeof View> | null> {
  const box = useRef<React.ComponentRef<typeof View>>(null);
  // Only the value at mount counts, as for a Button's focusOnMount.
  const atMount = useRef(enabled);
  useEffect(() => {
    if (!atMount.current || Platform.OS !== 'web') return;
    (box.current as unknown as HTMLElement | null)?.querySelector<HTMLElement>(CONTROL)?.focus();
  }, []);
  return box;
}

/**
 * A calendar in the list: its name, "File, 12 events", "Link, calendar.google.com, 1 event", "Google calendar, 40
 * events" or "Calendar, 3 events" for a kind the page doesn't know, the repeating events it left out, and for a link or
 * a Google calendar its status in words (none when `ok`) before the time of its last refresh that worked; then "Refresh
 * now" (a link or a Google calendar; "Refreshing…" while it runs, and every row's disabled meanwhile), "Reconnect" when
 * the popover offers it (`onReconnect`), and "Remove" (disabled while its own row refreshes, so the refresh can't answer
 * 404 for a calendar the popover has just removed).
 */
function CalendarRow(props: {
  calendar: OwnerCalendar;
  /** Who can mend it if Google no longer lets Townwise read it. */
  reconnect: Reconnect;
  /** This row's refresh runs. */
  refreshing: boolean;
  /** Any row's refresh runs: one at a time. */
  refreshBusy: boolean;
  /** The list is reading again. */
  reading: boolean;
  ro: ReadOnlyProps;
  /** "Reconnect" takes focus as it comes back, after the section it opened was cancelled. */
  focusReconnect: boolean;
  onRefresh: (calendar: OwnerCalendar) => void;
  /** Present only when the row offers "Reconnect". */
  onReconnect: ((calendar: OwnerCalendar) => void) | null;
  onRemove: (calendar: OwnerCalendar) => void;
}): React.JSX.Element {
  const { calendar, ro, onReconnect } = props;
  const row = rowLines(calendar);
  const read = refreshable(calendar.kind);
  const status = read ? statusWords(calendar.status, calendar.kind, props.reconnect) : null;
  return (
    <View role="listitem" style={styles.row}>
      <Small white>{calendar.label}</Small>
      <Mono>{row.summary}</Mono>
      {row.repeating === null ? null : <Small>{row.repeating}</Small>}
      {status === null ? null : <Small white>{status}</Small>}
      {row.updated === null ? null : <Mono>{row.updated}</Mono>}
      <Actions>
        {read ? (
          <Button
            variant="link"
            label={props.refreshing ? 'Refreshing…' : 'Refresh now'}
            accessibilityLabel={`${props.refreshing ? 'Refreshing…' : 'Refresh now'}: ${calendar.label}`}
            {...(ro ?? { disabled: props.refreshBusy || props.reading })}
            onPress={() => { props.onRefresh(calendar); }}
          />
        ) : null}
        {onReconnect === null ? null : (
          <Button
            variant="link"
            label={GOOGLE_COPY.reconnectAction}
            accessibilityLabel={`${GOOGLE_COPY.reconnectAction} ${calendar.label}`}
            focusOnMount={props.focusReconnect}
            {...(ro ?? { disabled: props.reading || props.refreshing })}
            onPress={() => { onReconnect(calendar); }}
          />
        )}
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

/**
 * The Google section's picker: the person's Google calendars as checkbox rows, the primary first with "Your main
 * calendar", one already on the location checked, disabled and "Added", and the checks capped at the location's room;
 * then "Add {n} calendars", which reads "Adding…" while the adds run, and Cancel. Its checks live in Calendars.
 */
function GooglePicker(props: {
  location: string;
  choices: readonly GoogleChoice[];
  checked: readonly string[];
  /** How many more calendars the location takes. */
  room: number;
  /** The adds are out: every control waits, disabled in place. */
  adding: boolean;
  /** The first control takes focus as the picker mounts. */
  focusFirst: boolean;
  onCheck: (id: string, next: boolean) => void;
  onAdd: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const box = useFocusFirstControl(props.focusFirst);
  const count = props.checked.length;
  return (
    <View ref={box} style={styles.form}>
      <Small white>{pickerLine(props.location)}</Small>
      <View style={styles.choices}>
        {props.choices.map((choice, index) => {
          const checked = choice.added || props.checked.includes(choice.id);
          const mainId = choice.primary ? `${GOOGLE_CHOICE_ID}-${String(index)}-main` : null;
          const addedId = choice.added ? `${GOOGLE_CHOICE_ID}-${String(index)}-added` : null;
          const describedBy = ids(mainId, addedId);
          return (
            <View key={choice.id} style={styles.choice}>
              <Checkbox
                label={choice.name}
                checked={checked}
                disabled={choice.added || props.adding || (!checked && count >= props.room)}
                onChange={(next) => { props.onCheck(choice.id, next); }}
                {...(describedBy === undefined ? {} : { describedBy })}
              />
              {mainId === null ? null : <Small nativeID={mainId}>{GOOGLE_COPY.mainCalendar}</Small>}
              {addedId === null ? null : <Small nativeID={addedId}>{GOOGLE_COPY.added}</Small>}
            </View>
          );
        })}
      </View>
      <Small>{roomLine(props.room)}</Small>
      <Small>{GOOGLE_COPY.shareLine}</Small>
      <Actions>
        <Button
          variant="outline"
          label={props.adding ? 'Adding…' : addGoogleLabel(count)}
          disabled={props.adding || count === 0}
          onPress={props.onAdd}
        />
        <Button variant="link" label="Cancel" disabled={props.adding} onPress={props.onCancel} />
      </Actions>
    </View>
  );
}

export function YourCalendars(props: YourCalendarsProps): React.JSX.Element {
  return <MessageFocus><Calendars {...props} /></MessageFocus>;
}

function Calendars(props: YourCalendarsProps): React.JSX.Element {
  const { onChanged } = props;
  const { api, me } = usePortal();
  const { location, org } = useLocation();
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
  // Every answer lands while the popover is open (it waits while an add, an import, a refresh or a Google choices read,
  // wait, connect or add runs), so focus is always in it when the messages line asks for it.
  const focusMessage = useFocusMessage();
  // Remove took its row away (or found it gone): once the dialog has closed, the messages line takes focus.
  const removeEnded = useRef(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OwnerCalendar | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const list = props.failed ? null : props.calendars;
  const googleOn = props.google.available;
  const count = list === null ? 0 : list.length;
  const platform = Platform.OS === 'web' ? 'web' : 'native';
  // "Add a Google calendar" shows on web while the list answers Google calendars on. The section opens only for someone
  // who may connect (`canConnect`), with the client id Google is asked with; staff see the button disabled in place with
  // the staff line under the actions, and nothing they press starts Google's window.
  const googleShown = Platform.OS === 'web' && props.google.available;
  const googleClientId = googleShown && props.google.canConnect ? props.google.clientId : null;
  const staffGoogle = googleShown && !props.google.canConnect;
  // Staff's disabled "Add a Google calendar" is described by the read-only line under view-as and by the staff line.
  const googleDescribedBy = ids(readOnlyId, staffGoogle ? STAFF_ID : null);
  const [googleStep, setGoogleStep] = useState<GoogleStep>('closed');
  const [choices, setChoices] = useState<readonly GoogleChoice[]>([]);
  const [checked, setChecked] = useState<readonly string[]>([]);
  // The choices came from a connect in this section: its Cancel, with nothing added, drops the connection.
  const [fresh, setFresh] = useState(false);
  const [googleFocus, setGoogleFocus] = useState<GoogleFocus>(null);
  // A refusal's words while the explainer shows again. They sit in the section, just above "Continue to Google", which
  // takes focus, so they are in view; the popover's own messages line is above the long explainer. A new object for
  // each refusal, so the same words twice still bring Continue into view.
  const [googleWords, setGoogleWords] = useState<{ text: string } | null>(null);
  // The calendar whose Reconnect opened the section: its connect shows no picker, and its Cancel gives focus back to
  // that row's Reconnect. Null when "Add a Google calendar" opened it.
  const [reconnectId, setReconnectId] = useState<string | null>(null);
  // The `state` Google's answer must carry while the section waits on a press; null otherwise. Leaving the page forgets
  // it, so an answer that lands after never posts a code.
  const expectedStateRef = useRef<string | null>(null);
  useEffect(() => () => { expectedStateRef.current = null; }, []);

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
    const words = statusWords(saved.status, saved.kind, reconnectOf(saved, googleOn));
    setMessage(words === null ? { live: 'status', items: [refreshedLine(calendar.label)] } : { live: 'alert', items: [words] });
    onChanged(false);
  }, [api, location.id, googleOn, onChanged, onRefused, focusMessage]));

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

  /** The picker, with the choices and no checks. */
  const pick = useCallback((found: readonly GoogleChoice[], connected: boolean) => {
    setChoices(found);
    setChecked([]);
    setFresh(connected);
    setGoogleStep('picking');
    setGoogleFocus('picker');
  }, []);

  /** The explainer again, with a refusal's words when there are any. */
  const explain = useCallback((words: string | null) => {
    setGoogleStep('explaining');
    setGoogleFocus('continue');
    setGoogleWords(words === null ? null : { text: words });
    if (words !== null) setMessage(null);
  }, []);

  // The words can push the focused "Continue to Google" out of a phone sheet's view, and a blocked window answers inside
  // the press, so Continue never remounts to take focus again (which would scroll it into view). Each refusal brings
  // the focused control back into view; a remounted Continue has taken focus by now, since children's effects run first.
  useEffect(() => {
    if (googleWords === null || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && typeof focused.scrollIntoView === 'function') focused.scrollIntoView({ block: 'nearest' });
  }, [googleWords]);

  // A connected person's choices. A connection that is gone or dead falls back to the explainer; any other refusal
  // closes the section with its words, so "Add a Google calendar" can be pressed again.
  const loadChoices = useAction(useCallback(async () => {
    let found: GoogleChoice[];
    try {
      found = await fetchGoogleChoices(api, location.id);
    } catch (error) {
      if (connectionGone(error)) {
        explain(hasCode(error, 409, 'google_reconnect') ? GOOGLE_COPY.reconnect : null);
        return;
      }
      setGoogleStep('closed');
      setMessage({ live: 'alert', items: [googleRefusal(error)] });
      focusMessage();
      return;
    }
    pick(found, false);
  }, [api, location.id, explain, pick, focusMessage]));

  // Google's code, posted with the agreement; the choices it answers open the picker, unless Reconnect started it. Then
  // each of the person's own Google calendars here is refreshed now, one at a time, while the section still says it is
  // connecting and the popover waits, so the rows show their real status at once rather than when the refresh loop next
  // looks; the section closes with the reconnected line. The list reads again either way, so its `google.connected`
  // (and every calendar the connect healed) is current even if nothing is added.
  const connect = useAction(useCallback(async (code: string, reconnecting: boolean) => {
    let found: GoogleChoice[];
    try {
      found = await connectGoogleCalendars(api, location.id, code);
    } catch (error) {
      explain(googleRefusal(error));
      return;
    }
    if (reconnecting) {
      let failing = false;
      let later = false;
      for (const calendar of (list ?? []).filter((each) => each.kind === 'google' && each.mine)) {
        try {
          if ((await refreshOwnerCalendar(api, location.id, calendar.id)).status !== 'ok') failing = true;
        } catch {
          // Refreshed in the last 5 minutes, Google busy, or gone: connect made it due, so the loop reads it.
          later = true;
        }
      }
      setGoogleStep('closed');
      setGoogleFocus(null);
      setGoogleWords(null);
      setReconnectId(null);
      const words = later ? GOOGLE_COPY.reconnectedLater : failing ? GOOGLE_COPY.reconnected : GOOGLE_COPY.reconnectedFresh;
      setMessage({ live: 'status', items: [words] });
      focusMessage();
    } else {
      pick(found, true);
    }
    onChanged(false);
  }, [api, location.id, list, explain, pick, onChanged, focusMessage]));

  // One add at a time, each with its own line. A refusal about another thing than that one calendar (the limit, the
  // account's adds, Google, the connection) would refuse the rest too, so it ends the batch.
  const addGoogle = useAction(useCallback(async (picked: readonly GoogleChoice[]) => {
    setMessage(null);
    const lines: string[] = [];
    let added = 0;
    let refused = false;
    let gone = false;
    for (const choice of picked) {
      let stop = false;
      try {
        lines.push(...addedLines(await addOwnerCalendar(api, location.id, { kind: 'google', googleCalendarId: choice.id })));
        added += 1;
      } catch (error) {
        refused = true;
        lines.push(refusedLine(choice.name, addRefusal(error, 'google', platform)));
        gone = connectionGone(error);
        stop = !aboutOneCalendar(error);
      }
      setMessage({ live: refused ? 'alert' : 'status', items: [...lines] });
      if (stop) break;
    }
    if (added > 0) {
      setGoogleStep('closed');
      setChoices([]);
      setChecked([]);
      setFresh(false);
      focusMessage();
      onChanged(true);
      return;
    }
    if (gone) {
      setGoogleStep('explaining');
      setGoogleFocus(null);
      setGoogleWords(null);
      setChoices([]);
      setChecked([]);
      setFresh(false);
      focusMessage();
      return;
    }
    // Nothing added: the picker stays, with focus on its add button.
    setGoogleStep('picking');
  }, [api, location.id, platform, onChanged, focusMessage]));

  function openGoogle(): void {
    // Only someone who may connect opens the section; staff's button is disabled in place.
    if (googleClientId === null) return;
    setReconnectId(null);
    if (props.google.connected) {
      setGoogleStep('loading');
      loadChoices.run();
      return;
    }
    explain(null);
  }

  /** The picker's Cancel; after a fresh connect it drops the unused connection. */
  function cancelPicker(): void {
    // A 404 or 409 (none, or one backing a calendar) changes nothing here, nor does a failure: the API's connection
    // check ends an unused connection a day after its connect.
    if (fresh) dropGoogleConnection(api).catch(() => undefined);
    closeGoogle();
  }

  /** A row's Reconnect: the section opens on its explainer, whatever the list says of the connection. */
  function reconnect(calendar: OwnerCalendar): void {
    setMessage(null);
    setReconnectId(calendar.id);
    explain(null);
  }

  /** The section closes, and "Add a Google calendar" (or the row's Reconnect that opened it) comes back with focus. */
  function closeGoogle(): void {
    setGoogleStep('closed');
    setChoices([]);
    setChecked([]);
    setFresh(false);
    setGoogleFocus(reconnectId === null ? 'add' : 'reconnect');
    setGoogleWords(null);
  }

  // An add, an import, a refresh, or a Google choices read, wait, connect or add is out: the popover waits for its
  // answer. A list read again that says Google calendars are off hides the section, and nothing then holds the popover.
  const googleBusy = googleClientId !== null
    && (googleStep === 'loading' || googleStep === 'waiting' || googleStep === 'connecting' || googleStep === 'adding');
  const busy = add.pending || importFile.pending || refresh.pending || googleBusy;
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
        onPress={() => {
          // A part of the Google section that shows again as the popover opens takes no focus, which stays on Close.
          setGoogleFocus(null);
          setOpen(true);
        }}
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
                reconnect={reconnectOf(calendar, googleOn)}
                refreshing={refresh.pending && refreshingId === calendar.id}
                refreshBusy={refresh.pending}
                reading={props.reading}
                ro={ro}
                focusReconnect={googleFocus === 'reconnect' && reconnectId === calendar.id}
                onRefresh={(chosen) => { setRefreshingId(chosen.id); refresh.run(chosen); }}
                // While the section is open it stands in for every Reconnect, as for "Add a Google calendar".
                onReconnect={googleClientId !== null && googleStep === 'closed' && calendar.kind === 'google' && calendar.status === 'google_revoked'
                  && calendar.mine ? reconnect : null}
                onRemove={(chosen) => { removeEnded.current = false; setStaleError(remove.error); setRemoving(chosen); }}
              />
            ))}
          </View>
        )}
        {message === null ? null : <Messages live={message.live} takesFocus items={message.items} />}
        <Actions>
          <IcsImport
            describedBy={HELP_ID}
            pending={importFile.pending}
            readOnlyId={readOnlyId}
            google={props.google.available}
            onFile={importFile.run}
            onRefusal={onRefused}
          />
          {adding ? null : (
            <Button variant="outline" label="Add a link" focusOnMount={form === 'cancelled'} {...ro} onPress={() => { setForm('opening'); }} />
          )}
          {/* While a connected person's choices are read it stays in place, disabled, so it keeps focus. */}
          {!googleShown || (googleStep !== 'closed' && googleStep !== 'loading') ? null : (
            <Button
              variant="outline"
              label={googleStep === 'loading' ? GOOGLE_COPY.loadingChoices : GOOGLE_COPY.add}
              focusOnMount={googleFocus === 'add'}
              {...(googleClientId === null
                ? { disabled: true, ...(googleDescribedBy === undefined ? {} : { describedBy: googleDescribedBy }) }
                : (ro ?? { disabled: googleStep === 'loading' }))}
              onPress={openGoogle}
            />
          )}
        </Actions>
        {staffGoogle ? <Small nativeID={STAFF_ID}>{GOOGLE_COPY.staffLine}</Small> : null}
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
        {googleClientId === null || googleStep === 'closed' || googleStep === 'loading' ? null : (
          <View style={styles.form}>
            {googleStep === 'explaining' ? <Small nativeID={EXPLAINER_ID}>{GOOGLE_COPY.explainerShown}</Small> : null}
            {googleStep === 'explaining' && googleWords !== null ? <Messages live="alert" items={[googleWords.text]} /> : null}
            {googleStep === 'explaining' || googleStep === 'waiting' || googleStep === 'connecting' ? (
              <GoogleConnect
                clientId={googleClientId}
                loginHint={me.user.email}
                expectedStateRef={expectedStateRef}
                waiting={googleStep === 'waiting'}
                connecting={googleStep === 'connecting'}
                describedBy={EXPLAINER_ID}
                focusContinue={googleFocus === 'continue'}
                onWait={() => {
                  setMessage(null);
                  setGoogleWords(null);
                  setGoogleStep('waiting');
                }}
                onCode={(code) => {
                  setGoogleStep('connecting');
                  connect.run(code, reconnectId !== null);
                }}
                onCancel={() => { explain(null); }}
                onRefusal={explain}
                onClose={closeGoogle}
              />
            ) : null}
            {googleStep === 'picking' || googleStep === 'adding' ? (
              <GooglePicker
                location={shownLocationName(location, org)}
                choices={choices}
                checked={checked}
                room={Math.max(0, MAX_CALENDARS - count)}
                adding={googleStep === 'adding'}
                focusFirst={googleFocus === 'picker'}
                onCheck={(id, next) => {
                  setChecked((current) => (next ? [...current.filter((each) => each !== id), id] : current.filter((each) => each !== id)));
                }}
                onAdd={() => {
                  const picked = choices.filter((choice) => !choice.added && checked.includes(choice.id));
                  if (picked.length === 0 || addGoogle.pending) return;
                  setGoogleStep('adding');
                  addGoogle.run(picked);
                }}
                onCancel={cancelPicker}
              />
            ) : null}
          </View>
        )}
        <Button variant="link" label="How importing works" expanded={helpOpen} controls={HELP_ID} onPress={() => { setHelpOpen((value) => !value); }} />
        <Small nativeID={HELP_ID} style={helpOpen ? null : styles.hidden}>{helpText(props.google.available && props.google.canConnect)}</Small>
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
  choices: { gap: theme.space[1] },
  choice: { minWidth: 0 },
  hidden: { display: 'none' },
});
