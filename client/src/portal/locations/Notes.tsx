import { useCallback, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { formatDate } from '../format';
import { useAction, useLoad } from '../hooks';
import { usePortal, useReadOnly } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { NotesSkeleton } from '../skeleton';
import { Actions, Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DataTable } from '../ui/DataTable';
import { EmptyState, Notice, ReadOnlyLine, StatusTag } from '../ui/feedback';
import { Columns, Section, Stack } from '../ui/layout';
import { Body } from '../ui/text';
import { createNote, deleteNote, fetchNotes, updateNote, type Note, type NoteInput } from './api';
import { localToday } from './dates';
import { NoteForm } from './NoteForm';
import {
  datesLine, draftOf, EFFECT_LABEL, emptyDraft, guestsLine, hoursLine, KIND_LABEL, NOTE_COPY, sortNotes, splitNotes, weekdaysLine,
} from './noteRules';
import { LoadFailure, useOrgRefreshOnLeave } from './parts';

// P14 Notes, the tuning step (spec 16.3, 12): the intro, “Add a note” opening C6 inline above the lists, then
// “Coming up” (ending today or later) and “Past”. Authors edit and delete their own notes; org admins any
// (`canEdit`). Under view-as, Add, Edit and Delete are disabled in place. From the town's today on, a private event
// with a guest count, a buyout or a closure adjusts the published forecast on read (spec 14.5), and TownwiseAI reads
// every note, so the intro says both instead of the spec's “Nothing reads them yet.” A row shows a note's hours when
// it has them. Sales data's “Add a closure note.” opens the form as a closure (`?new=closure`). A note TownwiseAI made
// from a file someone let it read (`source`, D34) says so under its author, and its edit form says undoing that read
// removes it; there is no link, since the note knows only the file's id.
// A 404 on a write means the note, or its location, was deleted in the meantime (spec 10.9): the form or dialog
// closes, an edit or delete says “This note isn’t available.”, and the list loads again, which shows “This
// location isn’t available.” if the location went too.

const READ_ONLY_ID = 'notes-ro';
const NOTE_GONE = 'This note isn’t available.';

type FormState = { mode: 'new'; kind: 'closure' | null } | { mode: 'edit'; note: Note } | null;

function NoteCell(props: { note: Note; selected: boolean }): React.JSX.Element {
  const { note, selected } = props;
  return (
    <View style={styles.cell}>
      <View style={styles.kind}>
        {selected ? <View style={styles.square} /> : null}
        <Text style={[styles.who, selected ? styles.whoOn : null]}>{KIND_LABEL[note.kind]}</Text>
      </View>
      {note.detail === null ? null : <Text style={styles.note}>{note.detail}</Text>}
    </View>
  );
}

/** “Mondays only, 6 pm to 9 pm”: the weekdays and the hours, when the note has either. */
function whenLine(note: Note): string | null {
  const parts = [weekdaysLine(note.weekdays), hoursLine(note)].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(', ');
}

function TwoLines(props: { first: string; second: string | null }): React.JSX.Element {
  return (
    <View style={styles.cell}>
      <Text style={styles.value}>{props.first}</Text>
      {props.second === null ? null : <Text style={styles.note}>{props.second}</Text>}
    </View>
  );
}

/** Who wrote it and when; a note TownwiseAI made from a file says so under them, with no link (D34). */
function AddedCell(props: { note: Note }): React.JSX.Element {
  const { note } = props;
  return (
    <View style={styles.cell}>
      <Text style={styles.value}>{note.createdByEmail}</Text>
      <Text style={styles.note}>{formatDate(note.createdAt)}</Text>
      {fromAiFile(note) ? <Text style={styles.note}>{NOTE_COPY.fromAiFile}</Text> : null}
    </View>
  );
}

function fromAiFile(note: Note): boolean {
  return note.source?.via === 'ai_file';
}

function NotesTable(props: {
  label: string;
  notes: readonly Note[];
  selectedId: string | null;
  readOnlyId: string | null;
  onEdit: (note: Note) => void;
  onDelete: (note: Note) => void;
}): React.JSX.Element {
  const { readOnlyId } = props;
  return (
    <DataTable
      label={props.label}
      columns={[
        { key: 'note', label: 'Note', flex: 1.5 },
        { key: 'dates', label: 'Dates', flex: 1.3 },
        { key: 'effect', label: 'Effect', flex: 1 },
        { key: 'added', label: 'Added by', flex: 1.8 },
        { key: 'actions', label: 'Actions', hiddenLabel: true, flex: 1.3 },
      ]}
      rows={props.notes.map((note) => {
        const name = `${KIND_LABEL[note.kind]} note, ${datesLine(note)}`;
        const ro = readOnlyId === null ? null : { disabled: true, describedBy: readOnlyId };
        return {
          key: note.id,
          selected: note.id === props.selectedId,
          cells: {
            note: <NoteCell note={note} selected={note.id === props.selectedId} />,
            dates: <TwoLines first={datesLine(note)} second={whenLine(note)} />,
            effect: <TwoLines first={EFFECT_LABEL[note.effect]} second={guestsLine(note.expectedGuests)} />,
            added: <AddedCell note={note} />,
            actions: note.canEdit ? (
              <Actions>
                <Button variant="link" label="Edit" accessibilityLabel={`Edit ${name}`} {...ro} onPress={() => { props.onEdit(note); }} />
                <Button variant="link" label="Delete" accessibilityLabel={`Delete ${name}`} {...ro} onPress={() => { props.onDelete(note); }} />
              </Actions>
            ) : null,
          },
        };
      })}
    />
  );
}

export function Notes(): React.JSX.Element {
  const { location } = useLocation();
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const params = useLocalSearchParams<{ new?: string }>();
  const markStale = useOrgRefreshOnLeave();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const [form, setForm] = useState<FormState>(() => (params.new === 'closure' && !readOnly ? { mode: 'new', kind: 'closure' } : null));
  const router = useRouter();
  const closeForm = useCallback(() => {
    setForm(null);
    // A query (`?new=`) may have opened it; drop that, so a reload or Back shows the list, not an empty form again.
    if (params.new !== undefined) router.setParams({ new: undefined });
  }, [params.new, router]);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const [today] = useState(() => localToday());

  const { state, reload } = useLoad(useCallback(() => fetchNotes(api, location.id), [api, location.id]));
  // The list as loaded, with this page's own saves and deletes applied (no reload, so the saved note stays selected).
  const [local, setLocal] = useState<{ from: Note[]; notes: Note[] } | null>(null);
  const loaded = state.status === 'ready' ? state.data : null;
  const notes = loaded === null ? null : (local !== null && local.from === loaded ? local.notes : loaded);
  const change = useCallback((update: (current: Note[]) => Note[]) => {
    if (loaded === null) return;
    setLocal((previous) => ({ from: loaded, notes: update(previous !== null && previous.from === loaded ? previous.notes : loaded) }));
  }, [loaded]);

  const gone = useCallback((text: string | null) => {
    closeForm();
    setDeleting(null);
    setSelectedId(null);
    setNotice(text);
    markStale();
    reload();
  }, [closeForm, markStale, reload]);

  const editing = form?.mode === 'edit' ? form.note : null;
  const save = useCallback(async (input: NoteInput): Promise<Note | null> => {
    try {
      return editing === null ? await createNote(api, location.id, input) : await updateNote(api, location.id, editing.id, input);
    } catch (error) {
      if (!hasCode(error, 404, 'not_found')) throw error;
      // A new note can only miss its location, which the reload reports; an edit can miss its note.
      gone(editing === null ? null : NOTE_GONE);
      return null;
    }
  }, [api, location.id, editing, gone]);

  const onSaved = useCallback((note: Note) => {
    change((current) => sortNotes([...current.filter((other) => other.id !== note.id), note]));
    markStale();
    closeForm();
    setSelectedId(note.id);
    setNotice('Saved.');
  }, [change, closeForm, markStale]);

  const remove = useAction(useCallback(async (note: Note) => {
    try {
      await deleteNote(api, location.id, note.id);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) { gone(NOTE_GONE); return; }
      throw error;
    }
    change((current) => current.filter((other) => other.id !== note.id));
    markStale();
    setDeleting(null);
    setSelectedId(null);
    if (editing?.id === note.id) setForm(null);
    setNotice('Deleted the note.');
  }, [api, location.id, change, markStale, editing, gone]));

  function open(next: FormState): void {
    setNotice(null);
    setSelectedId(null);
    setForm(next);
  }

  const add = readOnlyId === null
    ? <Button label="Add a note" onPress={() => { open({ mode: 'new', kind: null }); }} />
    : <Button label="Add a note" disabled describedBy={readOnlyId} />;

  let content: React.ReactNode;
  if (state.status === 'loading') content = <NotesSkeleton label="Loading notes" />;
  else if (state.status === 'failed') content = <LoadFailure error={state.error} onRetry={reload} />;
  else if (notes === null || notes.length === 0) content = form === null ? <EmptyState text="No notes yet.">{add}</EmptyState> : null;
  else {
    const { comingUp, past } = splitNotes(notes, today);
    const table = (label: string, rows: Note[]): React.JSX.Element => (
      <NotesTable
        label={label}
        notes={rows}
        selectedId={selectedId}
        readOnlyId={readOnlyId}
        onEdit={(note) => { open({ mode: 'edit', note }); }}
        onDelete={(note) => { setStaleError(remove.error); setDeleting(note); }}
      />
    );
    content = (
      <Stack gap={32}>
        {form === null ? <Actions>{add}</Actions> : null}
        {comingUp.length === 0 ? null : <Section first kicker="End date today or later" title="Coming up">{table('Notes coming up', comingUp)}</Section>}
        {past.length === 0 ? null : <Section first kicker="Ended before today" title="Past">{table('Past notes', past)}</Section>}
      </Stack>
    );
  }

  return (
    <View>
      {notice === null ? null : <View style={styles.notice}><Notice text={notice} /></View>}
      <Columns
        main={(
          <Stack>
            <Body>
              Notes record what your sales can’t show: a closure, a private event, an opening. Add past ones to explain unusual
              days, and upcoming ones for the dates ahead. Townwise keeps them with this location. From today on, a private event with a
              guest count, a buyout or a closure changes Townwise’s forecast for its days. TownwiseAI reads every note.
            </Body>
            <View style={styles.tagline}>
              <StatusTag kind="planned" label="Planned" />
              <Text style={styles.taglineText}>Talking to your model is planned.</Text>
            </View>
          </Stack>
        )}
      />
      <View style={styles.body}>
        {readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />}
        {form === null || state.status !== 'ready' ? null : (
          <Columns
            main={(
              <NoteForm
                key={editing?.id ?? 'new'}
                initial={editing === null ? emptyDraft(form.mode === 'new' && form.kind !== null ? form.kind : undefined) : draftOf(editing)}
                editing={editing !== null}
                fromAiFile={editing !== null && fromAiFile(editing)}
                save={save}
                onSaved={onSaved}
                onCancel={closeForm}
              />
            )}
          />
        )}
        {content}
      </View>
      <ConfirmDialog
        visible={deleting !== null}
        title="Delete this note?"
        body="This can’t be undone."
        confirmLabel="Delete note"
        pendingLabel="Deleting…"
        pending={remove.pending}
        error={remove.error === staleError ? null : remove.error}
        onConfirm={() => { if (deleting !== null) remove.run(deleting); }}
        onCancel={() => { setDeleting(null); }}
      />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  notice: { marginBottom: theme.space[8] },
  tagline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 8 },
  taglineText: { ...theme.type.small, color: c.text2 },
  body: { marginTop: theme.space[8], paddingTop: theme.space[8], borderTopWidth: 1, borderTopColor: c.border, gap: theme.space[8] },
  cell: { gap: 2, paddingVertical: 4, minWidth: 0 },
  kind: { flexDirection: 'row', alignItems: 'center', columnGap: 8 },
  square: { width: 6, height: 6, backgroundColor: c.mint },
  who: { ...theme.type.ui, color: c.white },
  whoOn: { color: c.mint },
  value: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text2 },
  note: { ...theme.type.small, color: c.text2 },
});
