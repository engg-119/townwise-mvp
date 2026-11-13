import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';

import { theme } from '../../theme';
import { fetchCalendar } from '../analytics/api';
import { MONTH_NAMES } from '../analytics/words';
import { hasCode } from '../errors';
import { fetchForecast } from '../estimates/api';
import { useAction, useBreakpoint, useLoad } from '../hooks';
import { createNote, deleteNote, fetchNotes, fetchSalesDays, updateNote, type Note, type NoteInput } from '../locations/api';
import { localToday, monthRange } from '../locations/dates';
import { shownLocationName } from '../locations/naming';
import { NoteForm } from '../locations/NoteForm';
import { draftOf, draftOfImported, emptyDraft, type NoteDraft } from '../locations/noteRules';
import { LoadFailure, Loading, useOrgRefreshOnLeave } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { fetchRules } from '../rules/api';
import { useLocation } from '../shell/LocationShell';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, Notice } from '../ui/feedback';
import { CalendarDay, PANEL_ID } from './CalendarDay';
import { CalendarGrid } from './CalendarGrid';
import { IcsImport } from './IcsImport';
import { Toolbar } from './Toolbar';
import {
  ALL_FILTERS, calendarMonth, dayView, monthBounds, monthLabel, pastRange, savedNotice, selectedDay, stepMonth, tooltipLines,
  type CalendarInput, type FilterKey, type Filters, type ImportedCalendar, type ImportedEvent,
} from './model';

// P27 Calendar (/locations/[locationId]/calendar, members; spec 16.3, D30): the month's
// days with the published forecast's guests, what drives each day, and the location's notes, which a member adds,
// edits and deletes from the day. `?day=YYYY-MM-DD` is the selected day and the month follows it (an invalid day, or
// one outside the 12 months either side of today's, is today). It reads five existing member routes: the notes with the
// business rules (D31; the day lists the rules whose schedule covers it, edited on Rules), the month's town calendar
// and stored days (the past part only), and the month's forecast (one read of at most 31 days). The forecast read stands alone: when it fails the page still shows, with Try again for it only. After a
// note is saved or deleted the notes and the forecast read again, since the API adjusts the forecast from notes on
// read (spec 14.5) and the client never adds a note's guests itself; meanwhile the old figures stay, dimmed and
// aria-busy, and a save's notice says “Saved.” until the new read says what the note did to the day. Under view-as the page shows in full with its writes disabled in place. The owner's calendar file
// (web only, spec 16.3 P27 and 17) is read in the browser and held in this page's state only, so it is gone on
// reload or on leaving; importing one turns "Your calendar" on, and Make a note opens the form from one of its events
// with its dates and hours but never its title. Importing is allowed under view-as, since it sends nothing; Make a
// note is disabled there. "Today" is the device's date.

const READ_ONLY_ID = 'calendar-ro';
const NOTE_GONE = 'This note isn’t available.';

/** The desktop panel beside the grid, sticky as Analytics' is. */
const sticky = (Platform.OS === 'web' ? { position: 'sticky', top: 16 } : {}) as unknown as ViewStyle;

/** A new note's `source` keys its form, so the form starts again from each event in the owner's calendar file. */
type FormState = { mode: 'new'; draft: NoteDraft; source: string } | { mode: 'edit'; note: Note } | null;

interface Kept<T> {
  /** The newest answer, or the last one while a read runs again; null before the first. */
  data: T | null;
  busy: boolean;
  /** The newest read's failure; null otherwise. */
  error: unknown;
  /** Whether any read has answered or failed: after that the page shows while it reads again, even with no answer. */
  settled: boolean;
  reload: () => void;
}

/** useLoad that keeps its last answer while it reads again, so a grid stays in place, dimmed, until the next one lands. */
function useKept<T>(load: () => Promise<T>): Kept<T> {
  const { state, reload } = useLoad(load);
  const [kept, setKept] = useState<T | null>(null);
  const [settled, setSettled] = useState(false);
  const ready = state.status === 'ready' ? state.data : null;
  if (ready !== null && ready !== kept) setKept(ready);
  if (!settled && state.status !== 'loading') setSettled(true);
  return {
    data: ready ?? kept, busy: state.status === 'loading', error: state.status === 'failed' ? state.error : null,
    settled: settled || state.status !== 'loading', reload,
  };
}

/** The panel's notice: words, or the note just saved, whose notice waits for the forecast read again (savedNotice). */
type PanelNotice = string | { savedId: string } | null;

export function CalendarPage(): React.JSX.Element {
  const { location } = useLocation();
  // Keyed by the location, so nothing kept from one location's reads ever shows under another's header.
  return <CalendarView key={location.id} />;
}

function CalendarView(): React.JSX.Element {
  const { location, org } = useLocation();
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const router = useRouter();
  const params = useLocalSearchParams<{ day?: string }>();
  const { desktop } = useBreakpoint();
  const markStale = useOrgRefreshOnLeave();
  const [today] = useState(localToday);
  const selected = selectedDay(typeof params.day === 'string' ? params.day : undefined, today);
  const month = selected.slice(0, 7);
  const bounds = useMemo(() => monthBounds(today), [today]);
  const [filters, setFilters] = useState<Filters>(ALL_FILTERS);
  // The owner's calendar file (spec 17), in this page's memory only.
  const [imported, setImported] = useState<ImportedCalendar | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const [notice, setNotice] = useState<PanelNotice>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const [chosen, setChosen] = useState(0);
  const locationName = shownLocationName(location, org);

  // The notes and the business rules, read and read again together: a write reads both again with the forecast.
  const notes = useKept(useCallback(async () => {
    const [list, rules] = await Promise.all([fetchNotes(api, location.id), fetchRules(api, location.id)]);
    return { list, rules: rules.rules };
  }, [api, location.id]));
  const monthData = useKept(useCallback(async () => {
    const past = pastRange(month, today);
    const [calendar, days] = await Promise.all([
      fetchCalendar(api, location.id, monthRange(month)),
      past === null ? Promise.resolve([]) : fetchSalesDays(api, location.id, past),
    ]);
    return { month, calendar, days };
  }, [api, location.id, month, today]));
  const forecast = useKept(useCallback(
    async () => ({ month, window: await fetchForecast(api, location.id, monthRange(month)) }),
    [api, location.id, month],
  ));

  // Below 1024px on web the panel is under the grid: a day clicked or entered there brings it into view (an arrow key
  // keeps the focused cell in view instead).
  useEffect(() => {
    if (chosen === 0 || desktop || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const panel = document.getElementById(PANEL_ID);
    if (panel !== null && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'start' });
  }, [chosen, desktop]);

  const shown = monthData.data;
  const forecastFailed = forecast.error !== null && shown?.month === month;
  const forecastWindow = forecastFailed || forecast.data === null || forecast.data.month !== shown?.month ? null : forecast.data.window;
  const input = useMemo<CalendarInput | null>(() => (shown === null || notes.data === null ? null : {
    today, month: shown.month, forecast: forecastWindow, salesDays: shown.days, events: shown.calendar.events, notes: notes.data.list,
    rules: notes.data.rules, imported: imported?.events ?? [], filters,
  }), [today, shown, forecastWindow, notes.data, imported, filters]);
  const rows = useMemo(() => (input === null ? [] : calendarMonth(input)), [input]);
  const view = useMemo(() => (input?.month === month ? dayView(selected, input) : null), [input, month, selected]);

  const { reload: reloadNotes } = notes;
  const { reload: reloadForecast } = forecast;
  const reloadDay = useCallback(() => {
    markStale();
    reloadNotes();
    reloadForecast();
  }, [markStale, reloadNotes, reloadForecast]);

  const gone = useCallback((text: string) => {
    setForm(null);
    setDeleting(null);
    setNotice(text);
    reloadDay();
  }, [reloadDay]);

  const editing = form?.mode === 'edit' ? form.note : null;
  const save = useCallback(async (body: NoteInput): Promise<Note | null> => {
    try {
      return editing === null ? await createNote(api, location.id, body) : await updateNote(api, location.id, editing.id, body);
    } catch (error) {
      if (!hasCode(error, 404, 'not_found')) throw error;
      gone(NOTE_GONE);
      return null;
    }
  }, [api, location.id, editing, gone]);

  const onSaved = useCallback((note: Note) => {
    setForm(null);
    setNotice({ savedId: note.id });
    reloadDay();
  }, [reloadDay]);

  const remove = useAction(useCallback(async (note: Note) => {
    try {
      await deleteNote(api, location.id, note.id);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) { gone(NOTE_GONE); return; }
      throw error;
    }
    setDeleting(null);
    if (editing?.id === note.id) setForm(null);
    setNotice('Deleted the note.');
    reloadDay();
  }, [api, location.id, editing, gone, reloadDay]));

  const select = useCallback((date: string, moved = false) => {
    // A click, Enter or Space brings the panel into view below 1024px, on the selected day too (an arrow key has
    // already selected the day Enter opens).
    if (!moved) setChosen((count) => count + 1);
    if (date === selected) return;
    setForm(null);
    setNotice(null);
    router.setParams({ day: date });
  }, [router, selected]);

  const toMonth = useCallback((next: string) => {
    select(next === today.slice(0, 7) ? today : `${next}-01`, true);
  }, [select, today]);

  const toggle = useCallback((key: FilterKey) => { setFilters((current) => ({ ...current, [key]: !current[key] })); }, []);
  const onImport = useCallback((next: ImportedCalendar) => {
    setImported(next);
    setFilters((current) => ({ ...current, imported: true }));
  }, []);
  const tooltip = useCallback((date: string) => (input === null ? null : tooltipLines(date, input)), [input]);

  const failure = notes.error ?? monthData.error;
  if (failure !== null) {
    return <LoadFailure error={failure} onRetry={() => { notes.reload(); monthData.reload(); }} />;
  }
  // The forecast holds the page back only for its first read: after one answer or failure, Try again, a month change
  // and a note write keep the page showing, dimmed, with no forecast figures until it answers.
  if (input === null || shown === null || !forecast.settled) {
    return <Loading text="Loading the calendar" minHeight={480} />;
  }
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const busy = monthData.busy || notes.busy || forecast.busy || shown.month !== month;
  // After a save the forecast reads again; until it answers, the old read can't say what the note did.
  const noticeText = notice === null || typeof notice === 'string' ? notice
    : forecast.busy || input.month !== month ? 'Saved.' : savedNotice(selected, input, notice.savedId);
  const unpublished = forecastWindow !== null && !forecastWindow.available && forecastWindow.reason === 'no_published_forecast';

  const formNode = form === null ? null : (
    <NoteForm
      key={form.mode === 'edit' ? form.note.id : `${form.source}-${selected}`}
      initial={form.mode === 'edit' ? draftOf(form.note) : form.draft}
      editing={form.mode === 'edit'}
      save={save}
      onSaved={onSaved}
      onCancel={() => { setForm(null); }}
    />
  );

  const panel = (
    <CalendarDay
      view={view}
      locationName={locationName}
      rulesHref={locationHref(location.id, 'rules')}
      notice={noticeText}
      readOnlyId={readOnlyId}
      readOnlyText={line}
      form={formNode}
      onAdd={() => {
        setNotice(null);
        setForm({ mode: 'new', draft: { ...emptyDraft('private_event'), startDate: selected, endDate: selected }, source: 'add' });
      }}
      onEdit={(note) => { setNotice(null); setForm({ mode: 'edit', note }); }}
      onDelete={(note) => { setStaleError(remove.error); setDeleting(note); }}
      onMakeNote={(event: ImportedEvent) => {
        setNotice(null);
        setForm({ mode: 'new', draft: draftOfImported(event), source: `ics-${event.uid}` });
      }}
    />
  );

  return (
    <View style={styles.page}>
      {unpublished ? (
        <Notice
          text={`Townwise hasn’t published a forecast for ${locationName} yet. Days show your history, your notes and ${location.town.name}’s calendar. Notes you add now count as soon as a forecast is published.`}
        />
      ) : null}
      <Toolbar
        month={monthLabel(month)}
        canPrevious={month > bounds.first}
        canNext={month < bounds.last}
        onPrevious={() => { toMonth(stepMonth(month, -1)); }}
        onNext={() => { toMonth(stepMonth(month, 1)); }}
        onToday={() => { select(today); }}
        filters={filters}
        onFilter={toggle}
        imported={imported !== null}
      >
        <IcsImport today={today} imported={imported} onImport={onImport} />
      </Toolbar>
      {forecastFailed ? (
        <ErrorNotice message={`Couldn’t load the forecast for ${MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? ''}. Try again.`} onRetry={forecast.reload} />
      ) : null}
      <View style={desktop ? styles.split : styles.stacked}>
        <View style={desktop ? styles.wide : null}>
          <CalendarGrid rows={rows} selected={selected} onSelect={select} busy={busy} label={monthLabel(shown.month)} tooltip={tooltip} />
        </View>
        <View style={desktop ? [styles.narrow, sticky] : null}>{panel}</View>
      </View>
      <ConfirmDialog
        visible={deleting !== null}
        title="Delete this note?"
        body="The forecast for its days goes back to Townwise’s model."
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

const styles = StyleSheet.create({
  page: { gap: theme.space[6] },
  split: { flexDirection: 'row', alignItems: 'flex-start', columnGap: theme.space.gutter },
  stacked: { gap: theme.space[8] },
  wide: { flex: 8, minWidth: 0 },
  narrow: { flex: 4, minWidth: 0 },
});
