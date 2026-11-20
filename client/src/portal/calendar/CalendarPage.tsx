import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';

import { ApiError, type ApiClient } from '../../api/client';
import { forgetChat, lastChatKey } from '../../chat/lastChat';
import { lastChatStore } from '../../chat/lastChatStore';
import { theme } from '../../theme';
import { fetchCalendar, type ResearchedEvent } from '../analytics/api';
import { noteCovers, trustedGuestDays } from '../analytics/days';
import { dayMonthRange } from '../analytics/week';
import { MONTH_NAMES } from '../analytics/words';
import { errorCopy, hasCode } from '../errors';
import { fetchForecast } from '../estimates/api';
import { useAction, useBreakpoint, useLoad } from '../hooks';
import { createNote, deleteNote, fetchNotes, fetchSalesDays, updateNote, type NewNoteInput, type Note, type NoteInput } from '../locations/api';
import { addDays, localToday } from '../locations/dates';
import { shownLocationName } from '../locations/naming';
import { NoteForm } from '../locations/NoteForm';
import { draftOf, draftOfImported, emptyDraft, type NoteDraft } from '../locations/noteRules';
import { LoadFailure, useOrgRefreshOnLeave } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { fetchResearch, updateResearchedEvent, type ResearchedEventChange, type ResearchedEventFields } from '../research/api';
import { ASK_FOUND_QUERY, handOffAsk } from '../research/ask';
import { askDraft, BANNER_DISMISS, BANNER_DISMISS_LABEL, BANNER_LINK, bannerWords, EDIT_SHEET, FOUND_NOTICES } from '../research/copy';
import { bannerShows, markSeen, readSeen, runMark } from '../research/seen';
import { fetchRules } from '../rules/api';
import { useLocation } from '../shell/LocationShell';
import { CalendarSkeleton } from '../skeleton';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, InlineNotice } from '../ui/feedback';
import { MessageFocus, useFocusMessage } from '../ui/messageFocus';
import { Small } from '../ui/text';
import { Popover, type PopoverAnchor, type PopoverProps } from '../ui/Popover';
import { clearArrival, isRevealArrival } from './arrival';
import { CalendarDay, PANEL_ID } from './CalendarDay';
import { CalendarGrid } from './CalendarGrid';
import { CalendarWeek } from './CalendarWeek';
import { FoundEditForm } from './FoundEditForm';
import { fetchOwnerCalendarEvents, fetchOwnerCalendars, GOOGLE_OFF, type OwnerCalendarEvent } from './api';
import { calendarChart, chartDraws, lastYearRange } from './chart';
import {
  buildDays, buildGrid, gridDays, gridMonthFor, pastRangeFor, readRangeFor, shownFor, weekLabel, weekStartFor, type DateRange,
} from './grid';
import { MonthChart } from './MonthChart';
import { followSelection, stepView, stripDates, stripFor, VIEW_DAYS } from './strip';
import { CalendarFilters, Toolbar, type CalendarView } from './Toolbar';
import {
  ALL_FILTERS, dayView, monthBounds, monthCheckLine, monthLabel, outlookKey, savedNotice, selectedDay, showsBacktest, stepMonth, tooltipLines,
  type CalendarInput, type FilterKey, type Filters, type ImportedEvent,
} from './model';
import { YourCalendars } from './YourCalendars';
import { FigureKey } from './FigureKey';

// P28 Calendar (/locations/[locationId]/calendar, members; spec 16.3, D30): a month grid of 6 weeks (grid.ts), each
// day with the published forecast's guests, what drives each day, and the location's notes, which a member adds,
// edits and deletes from the day. `?day=YYYY-MM-DD` is the selected day (an invalid day, or one outside the 12 months
// either side of today's, is today). `?view=week` shows a week instead (CalendarWeek: day columns of cards, an agenda
// on phones and native), any other value the month; the switch sets only the URL, and Month, Week, Month returns to
// the same grid. The week is the 7-day block counted from today that holds the selected day (grid.ts weekStartFor:
// with no `?day=` it starts on today), and its Previous and Next move the day a week, so a whole block (stepWeek). The
// grid's month is this page's own state, not the URL's: a leading or trailing day is selected in place, and the grid
// moves only on Previous, Next, Today, PageUp and PageDown, or when `?day=` leaves its 42 days (a key past the first
// or last row, browser back or forward, a link). It reads the notes with the business rules (D31; the day lists the
// rules whose schedule covers it, edited on Rules), the location's calendars for "Your calendars" (spec 10.18,
// YourCalendars.tsx: part of the first load, so the button's name never changes after the page shows, and its failure
// leaves the page showing; with the list's `google`, whether Google calendars are on, the last one read is kept), and over the shown view's range (grid.ts readRangeFor: the grid's, and the week's own days
// only when they run past the grid's) its town calendar, its stored days (the past part only), its calendars' stored
// events and its forecast (one read of at most 42 days each), keyed by the range, so a switch or a day keeping it reads
// nothing. On a change of range the new grid or week shows at once, dimmed, with the days the kept reads cover and
// the rest pending until the new reads land. The forecast read stands alone, and the stored events' failure is caught
// inside the range's read: either failing leaves the page showing, without them, with Try again for that read only. A
// failed list read shows its own notice, whose Try again reads the list and the stored events again, and the stored
// events' notice shows only while the list answered with a calendar, so at most one of the two shows.
// The day panel's Add an event, a note's Edit and an event's Make a note open the note form (C6) in a popover anchored
// to the pressed button (refine-calendar-and-home design decision 2), headed "Add an event", "Edit note" or "Make a
// note": a press outside leaves it open; a save, Cancel, Escape, Android's back button, a 404 and any change of the
// selected day close it; while a save runs it waits for the answer. Focus returns to the opener, or when the opener goes
// (a 404, or an edit that moves the note off the day) moves to the panel's notice (MessageFocus, around the panel and
// the popover only). After a note is saved or deleted the notes and the forecast read again, since the API adjusts the
// forecast from notes on read (spec 14.5) and the client never adds a note's guests itself; meanwhile the old figures
// stay, dimmed and aria-busy, and a save's notice says “Saved.” until the new read says what the note did to the day.
// Under view-as the page shows in full with its writes disabled in place. The location's own calendars (spec 16.3 P28
// and 17, D33, D39) are kept by the API, each an imported .ics file, a link or a Google calendar, and their events show
// as "Your calendar" on web and native; after one is added the list and the range's stored events read again (never
// the forecast: stored events change it only through notes), and "Your calendar" turns on. Make a note opens the form from one of their
// events with its dates and hours but never its title, and the saved note is linked to that event by its calendar id and
// uid (calendar-event-suggestions), so the day panel says "Made from a calendar event" on it; it is disabled under view-as.
// Town research (D66, design decisions 11, 12 and 15): the calendar read's `found` shows under "Found by research" (a
// filter on by default, shown while the read holds a found event or the filter is off), last on each day. A found
// event's Edit opens the edit sheet (FoundEditForm) in the same popover, headed "Edit event"; Save, Hide and Reset each
// send the event's `head` as `basedOn` and read the range's calendar again. When someone changed the event since (409
// `changed_since`), an open sheet shows the event as it reads now, from the answer or the calendar read again, and
// says so; Hide and Reset say so in the panel. A 404 says the event isn't available. Ask TownwiseAI leaves a draft
// naming the event's title and date in memory (research/ask.ts), forgets the conversation kept for coming back, and
// opens TownwiseAI on a new conversation. A banner above the toolbar, linking to the Town tab, says what a run a person
// started (Research now, or the early run after the location was created or its place picked) is doing or found, until
// dismissed or the Town tab is opened (remembered on the device, research/seen.ts); a weekly run shows none, and a
// failed status read shows none. The status is read once per visit (no polling here; the Town tab polls).
// "Today" is the device's date.
// D64 (2026-11-19, owner request): the selected day stands out in both views (CalendarGrid*, CalendarWeek*); a forecast
// chart (chart.ts over these reads, with the sales days 364 days before the range read beside them for last year, a
// failure of which leaves only that line out) shows above the month grid (MonthChart.tsx, the grid month's days) and
// atop each day of the week view, on by default, hidden with the “Forecast chart” chip; and the week view scrolls
// sideways and snaps to a day. The page keeps the week view's first day in view (`start`) and the days it renders (the
// strip, strip.ts stripFor): `start` begins at the block from today that holds the selected day (D40) and follows a
// scroll once it stops (`onSettle`), the selected day moving to the nearest day in view when the scroll left it out;
// Previous week and Next week move both 7 days (stepView); and a change of the selected day that leaves the view (a
// key, Today, a link, browser back) shows the block that holds it. The week's label and its reads (readRangeFor) follow
// `start`.

const READ_ONLY_ID = 'calendar-ro';
/** The grid's slot: on web, focus that was on a cell the last render removed goes to the selected cell. */
const SLOT_ID = 'calendar-grid-slot';
const NOTE_GONE = 'This note isn’t available.';

/** The desktop panel beside the grid, sticky as Analytics' is. */
const sticky = (Platform.OS === 'web' ? { position: 'sticky', top: 16 } : {}) as unknown as ViewStyle;

/**
 * A new note's `source` keys its form, so the form starts again from each stored event (`{calendarId}:{uid}`); 'add' is
 * Add an event's. A note made from a stored event sends that event's `fromEvent` with it, so the API links the note
 * to the event (calendar-event-suggestions).
 */
type FormState =
  | { mode: 'new'; draft: NoteDraft; source: string; fromEvent?: NonNullable<NewNoteInput['fromEvent']> }
  | { mode: 'edit'; note: Note }
  | { mode: 'found'; event: ResearchedEvent; conflict: boolean; stale: string | null }
  | null;

/** The note form popover's heading, which names it: by the button that opened it. */
function formLabel(form: NonNullable<FormState>): string {
  if (form.mode === 'edit') return 'Edit note';
  if (form.mode === 'found') return EDIT_SHEET.heading;
  return form.source === 'add' ? 'Add an event' : 'Make a note';
}

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

/**
 * The range's stored events from the location's calendars. A failure is no events and a flag, so the grid still shows
 * without them (connect-owner-calendar design decision 11), as it does without a forecast.
 */
async function storedEventsOf(
  api: ApiClient, locationId: string, range: { from: string; to: string },
): Promise<{ events: OwnerCalendarEvent[]; failed: boolean }> {
  try {
    return { events: await fetchOwnerCalendarEvents(api, locationId, range), failed: false };
  } catch {
    return { events: [], failed: true };
  }
}

/** Whether a read was made for the days of `range`: the page keys its reads by their range. */
function sameRange(read: DateRange | undefined, range: DateRange): boolean {
  return read?.from === range.from && read.to === range.to;
}

/** The panel's notice: words, or the note just saved, whose notice waits for the forecast read again (savedNotice). */
type PanelNotice = { text: string; stays?: true } | { savedId: string } | null;

/**
 * The note form's popover. It sits with the day panel inside a MessageFocus of their own, so once it has gone with its
 * opener (`takeOpenerGone`: a 404, or an edit that moved the note off the day), the panel's notice, the only message
 * there, takes focus; a page notice above the grid (no published forecast, a failed read) never does.
 */
function NotePopover(props: Omit<PopoverProps, 'onDismiss'> & { takeOpenerGone: () => boolean }): React.JSX.Element {
  const { takeOpenerGone, ...popover } = props;
  const focusMessage = useFocusMessage();
  return <Popover {...popover} onDismiss={() => { if (takeOpenerGone()) focusMessage(); }} />;
}

export function CalendarPage(): React.JSX.Element {
  const { location } = useLocation();
  // Keyed by the location, so nothing kept from one location's reads ever shows under another's header.
  return <CalendarView key={location.id} />;
}

function CalendarView(): React.JSX.Element {
  const { location, org } = useLocation();
  const { api, me } = usePortal();
  const { readOnly, line } = useReadOnly();
  const router = useRouter();
  const params = useLocalSearchParams<{ day?: string; view?: string }>();
  const { desktop, phone } = useBreakpoint();
  const markStale = useOrgRefreshOnLeave();
  const [today] = useState(localToday);
  const selected = selectedDay(typeof params.day === 'string' ? params.day : undefined, today);
  const view: CalendarView = params.view === 'week' ? 'week' : 'month';
  const bounds = useMemo(() => monthBounds(today), [today]);
  // The month the grid shows, kept while the selected day is in its 42 days. `seen` is the selected day the page saw
  // last: only a render where it changed moves the grid (shownFor), so a render that sees a newly set month with the
  // old `?day=` (expo-router delivers setParams a render later) never undoes it. When the new month's grid lacks the old
  // day, that render shows `rendered`, the month shown last, which holds it, until the new `?day=` arrives.
  const [shownMonth, setShownMonth] = useState(() => selected.slice(0, 7));
  const [seen, setSeen] = useState(selected);
  const [rendered, setRendered] = useState(shownMonth);
  const nextShown = shownFor(shownMonth, seen, selected);
  const [form, setForm] = useState<FormState>(null);
  // The week view's first day in view and the days it renders (D64).
  const [start, setStart] = useState(() => weekStartFor(selected, today));
  const [strip, setStrip] = useState<DateRange>(() => stripFor(null, weekStartFor(selected, today), bounds, today));
  let viewStart = start;
  // Any change of the selected day closes the note form, including one that doesn't come through `select` (browser
  // back or forward to another Calendar entry, or a link), so a draft never shows over another day. One that leaves the
  // week view's days in view shows the block from today that holds it (D40).
  if (seen !== selected) {
    setSeen(selected);
    setForm(null);
    if (followSelection(selected, start) !== selected) {
      viewStart = weekStartFor(selected, today);
      setStart(viewStart);
    }
  }
  const nextStrip = stripFor(strip, viewStart, bounds, today);
  if (nextStrip !== strip) setStrip(nextStrip);
  // Whether the forecast chart shows (D64): page state, on at first.
  const [chartOn, setChartOn] = useState(true);
  if (nextShown !== shownMonth) setShownMonth(nextShown);
  const month = gridMonthFor(selected, nextShown, rendered);
  if (month !== rendered) setRendered(month);
  const [filters, setFilters] = useState<Filters>(ALL_FILTERS);
  // The button that opened the note form, which its popover is anchored to.
  const anchor = useRef<PopoverAnchor['current']>(null);
  // A save is out: the popover waits for its answer.
  const [saving, setSaving] = useState(false);
  // The save took the opener away (a 404, or an edit off the selected day): once the popover has gone, focus moves to
  // the panel's notice.
  const openerGone = useRef(false);
  const [notice, setNotice] = useState<PanelNotice>(null);
  const [deleting, setDeleting] = useState<Note | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const [chosen, setChosen] = useState(0);
  const locationName = shownLocationName(location, org);

  // The week view's first day in view, and what every read covers for the shown view (readRangeFor): the reads are keyed by its days.
  const weekStart = viewStart;
  const range = useMemo(() => readRangeFor(view, month, weekStart, bounds), [view, month, weekStart, bounds]);
  const { from, to } = range;
  // The notes and the business rules, read and read again together: a write reads both again with the forecast.
  const notes = useKept(useCallback(async () => {
    const [list, rules] = await Promise.all([fetchNotes(api, location.id), fetchRules(api, location.id)]);
    return { list, rules: rules.rules };
  }, [api, location.id]));
  const monthData = useKept(useCallback(async () => {
    const read: DateRange = { from, to };
    const past = pastRangeFor(read, today);
    const before = lastYearRange(read, today);
    const [calendar, days, stored, lastYear] = await Promise.all([
      fetchCalendar(api, location.id, read),
      past === null ? Promise.resolve([]) : fetchSalesDays(api, location.id, past),
      storedEventsOf(api, location.id, read),
      // The chart's same weekday last year (D64): its failure leaves only that line out.
      before === null ? Promise.resolve([]) : fetchSalesDays(api, location.id, before).catch(() => null),
    ]);
    return { range: read, calendar, days, stored: stored.events, storedFailed: stored.failed, lastYear };
  }, [api, location.id, from, to, today]));
  const forecast = useKept(useCallback(
    async () => ({ range: { from, to }, window: await fetchForecast(api, location.id, { from, to }) }),
    [api, location.id, from, to],
  ));
  const calendars = useKept(useCallback(() => fetchOwnerCalendars(api, location.id), [api, location.id]));
  // The location's research status, for the banner only: a failed read shows no banner.
  const research = useLoad(useCallback(() => fetchResearch(api, location.id), [api, location.id]));
  // The run the person last saw (dismissed, or the Town tab opened); undefined until the device's store answers.
  const [seenRun, setSeenRun] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void readSeen(lastChatStore, me.user.id, location.id).then((mark) => { if (live) setSeenRun(mark); });
    return () => { live = false; };
  }, [me.user.id, location.id]);
  // A found event's Hide or Reset that is out.
  const [foundPending, setFoundPending] = useState<string | null>(null);

  // Below 1024px on web the panel is under the grid: a day clicked or entered there brings it into view (an arrow key
  // keeps the focused cell in view instead).
  useEffect(() => {
    if (chosen === 0 || desktop || Platform.OS !== 'web' || typeof document === 'undefined') return;
    const panel = document.getElementById(PANEL_ID);
    if (panel !== null && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'start' });
  }, [chosen, desktop]);

  // A day Home's This month opened (item 70, arrival.ts) does the same, once the first read lands. Deferred a task,
  // since the frame's scroll to the top for the new path runs after this page's effects in the same commit.
  const reveal = useRef<boolean | null>(null);
  reveal.current ??= isRevealArrival(location.id, typeof params.day === 'string' ? params.day : undefined);
  useEffect(() => { clearArrival(); }, []);
  const loaded = monthData.data !== null && notes.data !== null;
  useEffect(() => {
    if (reveal.current !== true || !loaded) return undefined;
    if (desktop || Platform.OS !== 'web' || typeof document === 'undefined') {
      reveal.current = false;
      return undefined;
    }
    const timer = setTimeout(() => {
      reveal.current = false;
      const panel = document.getElementById(PANEL_ID);
      if (panel !== null && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'start' });
    }, 0);
    return () => { clearTimeout(timer); };
  }, [loaded, desktop]);

  // On web, whether focus is on a cell of the grid now, before this render replaces any (spec 16.3 P28): after it, if
  // the cell that had focus is gone (browser back or forward to a day in another grid), focus goes to the selected
  // cell rather than the page body. Read here, not tracked with blur, since browsers differ on whether removing a
  // focused node fires one; the grid's own focus after a key move runs first, and focus elsewhere is left alone.
  const hadFocus = Platform.OS === 'web' && typeof document !== 'undefined' && (document.getElementById(SLOT_ID)?.contains(document.activeElement) ?? false);
  useEffect(() => {
    if (!hadFocus || (document.activeElement !== null && document.activeElement !== document.body)) return;
    document.getElementById(SLOT_ID)?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
  });

  const shown = monthData.data;
  const forecastFailed = forecast.error !== null && sameRange(shown?.range, range);
  const forecastWindow = forecastFailed || forecast.data === null || !sameRange(shown?.range, forecast.data.range) ? null : forecast.data.window;
  // The stored events and "Your calendar" show only while the list's last read answered with a calendar: a failed list
  // read leaves the grid without them (design decision 11), as the button then reads "Your calendars".
  const hasCalendars = calendars.error === null && (calendars.data?.calendars ?? []).length > 0;
  const input = useMemo<CalendarInput | null>(() => (shown === null || notes.data === null ? null : {
    // D67: a guest count a note marks wrong reads as none, as the API's forecast read gives it no actual.
    today, covered: shown.range, forecast: forecastWindow, salesDays: trustedGuestDays(shown.days, notes.data.list), events: shown.calendar.events,
    notes: notes.data.list,
    rules: notes.data.rules, imported: hasCalendars ? shown.stored : [], found: shown.calendar.found, filters,
    // D72: past dates no run covers show the backtest's figure (Home leaves it out).
    backtest: true,
  }), [today, shown, forecastWindow, notes.data, hasCalendars, filters]);
  const rows = useMemo(() => (input === null || view === 'week' ? [] : buildGrid(month, input, bounds)), [input, view, month, bounds]);
  const stripDays = useMemo(() => stripDates(strip), [strip]);
  const week = useMemo(() => (input === null || view !== 'week' ? [] : buildDays(stripDays, input, bounds)), [input, view, stripDays, bounds]);
  // The key line under the grid while a shown day is an outlook day (D52): in the week view, the 7 days in view.
  const shownCells = useMemo(() => (view === 'week' ? week.filter((slot) => followSelection(slot.date, weekStart) === slot.date) : rows.flat())
    .flatMap((slot) => (slot.kind === 'day' && !slot.pending && !slot.outside ? [slot] : [])), [view, week, rows, weekStart]);
  const outlook = useMemo(() => outlookKey(shownCells), [shownCells]);
  // D72: the key names a backtest's dotted figure while a shown cell has one.
  const backtestShown = useMemo(() => showsBacktest(shownCells), [shownCells]);
  // The forecast chart (D64): the grid month's days above the grid, or the strip's days atop the week's; none while
  // the chip hides it or it has nothing to draw.
  const storedLastYear = monthData.data?.lastYear ?? null;
  const lastYear = useMemo(
    () => (storedLastYear === null || notes.data === null ? storedLastYear : trustedGuestDays(storedLastYear, notes.data.list)),
    [storedLastYear, notes.data],
  );
  const chart = useMemo(() => {
    if (input === null || !chartOn) return null;
    const dates = view === 'week' ? stripDays : gridDays(month).filter((date) => date.startsWith(month));
    const drawn = calendarChart(dates, input, lastYear);
    return chartDraws(drawn) ? drawn : null;
  }, [input, chartOn, view, stripDays, month, lastYear]);
  // The days the kept reads cover: their own range, which lags the shown one while a new range reads.
  const covered = input?.covered ?? null;
  const covers = useCallback((date: string) => covered !== null && date >= covered.from && date <= covered.to, [covered]);
  const dayPanel = useMemo(() => (input !== null && covers(selected) ? dayView(selected, input) : null), [input, covers, selected]);

  const { reload: reloadNotes } = notes;
  const { reload: reloadForecast } = forecast;
  const { reload: reloadCalendars } = calendars;
  const { reload: reloadMonth } = monthData;
  // After a calendar is added, refreshed or removed, and on the popover's Try again: the list and the range's stored
  // events. Stored events change the forecast only through notes, so neither the forecast nor the notes read again.
  const readCalendarsAgain = useCallback(() => {
    reloadCalendars();
    reloadMonth();
  }, [reloadCalendars, reloadMonth]);
  const onCalendarsChanged = useCallback((added: boolean) => {
    readCalendarsAgain();
    if (added) setFilters((current) => ({ ...current, imported: true }));
  }, [readCalendarsAgain]);
  const reloadDay = useCallback(() => {
    markStale();
    reloadNotes();
    reloadForecast();
  }, [markStale, reloadNotes, reloadForecast]);

  const gone = useCallback((text: string) => {
    setForm(null);
    setDeleting(null);
    // The note is gone and the write did not happen: that stays in the panel, never a toast.
    setNotice({ text, stays: true });
    reloadDay();
  }, [reloadDay]);

  // A found event's Save, Hide or Reset, with the event's head as basedOn; the range's calendar reads again after any
  // answer. 'conflict': someone changed it since, `current` the event as it reads now when the answer carried it.
  const changeFound = useCallback(async (event: ResearchedEvent, change: ResearchedEventChange): Promise<'saved' | { conflict: ResearchedEvent | null; hidden: boolean } | 'gone'> => {
    try {
      const result = await updateResearchedEvent(api, location.id, event.id, change);
      return result.status === 'saved' ? 'saved' : { conflict: result.current, hidden: result.hidden };
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) return 'gone';
      throw error;
    } finally {
      reloadMonth();
    }
  }, [api, location.id, reloadMonth]);

  const saveFound = useCallback(async (event: ResearchedEvent, fields: ResearchedEventFields): Promise<void> => {
    const answer = await changeFound(event, { op: 'edit', fields, basedOn: event.head });
    if (answer === 'saved') {
      setForm(null);
      setNotice({ text: FOUND_NOTICES.saved });
    } else if (answer === 'gone') {
      openerGone.current = true;
      setForm(null);
      setNotice({ text: FOUND_NOTICES.gone, stays: true });
    } else if (answer.hidden) {
      // Another member hid it meanwhile: an edit would change an event the Calendar no longer shows.
      setForm(null);
      setNotice({ text: FOUND_NOTICES.hiddenSince, stays: true });
    } else {
      // The sheet opens again on the event as it reads now (the answer's, else the calendar read again's).
      setForm(answer.conflict === null
        ? { mode: 'found', event, conflict: true, stale: event.head }
        : { mode: 'found', event: answer.conflict, conflict: true, stale: null });
    }
  }, [changeFound]);

  const foundAction = useCallback((event: ResearchedEvent, op: 'hide' | 'restore') => {
    setFoundPending(event.id);
    setNotice(null);
    changeFound(event, { op, basedOn: event.head }).then(
      (answer) => {
        if (answer === 'saved') setNotice({ text: op === 'hide' ? FOUND_NOTICES.hidden : FOUND_NOTICES.reset });
        else if (answer === 'gone') setNotice({ text: FOUND_NOTICES.gone, stays: true });
        else setNotice({ text: FOUND_NOTICES.changedSinceAction, stays: true });
      },
      (error: unknown) => {
        const tooMany = error instanceof ApiError && error.status === 409 && error.code === 'too_many_edits';
        setNotice({ text: tooMany ? FOUND_NOTICES.tooManyEdits : errorCopy(error), stays: true });
      },
    ).finally(() => { setFoundPending(null); });
  }, [changeFound]);

  const askFound = useCallback((event: ResearchedEvent) => {
    handOffAsk(location.id, askDraft(event.title, selected < event.start || selected > event.end ? event.start : selected, today));
    // A new conversation: forget the one kept for coming back before TownwiseAI opens.
    void forgetChat(lastChatStore, lastChatKey(me.user.id, location.id, me.viewAs?.target.userId ?? null)).finally(() => {
      router.push(`${locationHref(location.id, 'agent')}?${ASK_FOUND_QUERY}`);
    });
  }, [location.id, me.user.id, me.viewAs, router, selected, today]);

  const editing = form?.mode === 'edit' ? form.note : null;
  const fromEvent = form?.mode === 'new' ? form.fromEvent : undefined;
  const save = useCallback(async (body: NoteInput): Promise<Note | null> => {
    setSaving(true);
    try {
      if (editing === null) return await createNote(api, location.id, fromEvent === undefined ? body : { ...body, fromEvent });
      return await updateNote(api, location.id, editing.id, body);
    } catch (error) {
      if (!hasCode(error, 404, 'not_found')) throw error;
      // The note's Edit goes with it once the notes read again.
      openerGone.current = true;
      gone(NOTE_GONE);
      return null;
    } finally {
      setSaving(false);
    }
  }, [api, location.id, editing, fromEvent, gone]);

  const onSaved = useCallback((note: Note) => {
    // An edit that moved the note off the selected day: its Edit goes once the notes read again.
    if (editing !== null && !noteCovers(note, selected)) openerGone.current = true;
    setForm(null);
    setNotice({ savedId: note.id });
    reloadDay();
  }, [editing, selected, reloadDay]);

  const remove = useAction(useCallback(async (note: Note) => {
    try {
      await deleteNote(api, location.id, note.id);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) { gone(NOTE_GONE); return; }
      throw error;
    }
    setDeleting(null);
    if (editing?.id === note.id) setForm(null);
    setNotice({ text: 'Deleted the note.' });
    reloadDay();
  }, [api, location.id, editing, gone, reloadDay]));

  /** `grid`: the month to show (Previous, Next, Today, PageUp, PageDown), which can change when the day doesn't. */
  const select = useCallback((date: string, moved = false, grid: string | null = null) => {
    // A click, Enter or Space brings the panel into view below 1024px, on the selected day too (an arrow key has
    // already selected the day Enter opens).
    if (!moved) setChosen((count) => count + 1);
    if (grid !== null) setShownMonth(grid);
    if (date === selected) return;
    setForm(null);
    setNotice(null);
    router.setParams({ day: date });
  }, [router, selected]);

  // A press on the month chart's column (D64) selects its day as the grid does, and on web focus goes to that day's
  // cell, as a click in the grid leaves it there: never inside the aria-hidden chart, and the arrow keys go on from it.
  const selectFromChart = useCallback((date: string) => {
    select(date);
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    document.getElementById(SLOT_ID)?.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`)?.focus({ preventScroll: true });
  }, [select]);

  const toMonth = useCallback((next: string) => {
    select(next === today.slice(0, 7) ? today : `${next}-01`, true, next);
  }, [select, today]);

  // The URL holds the view: Month takes `view` out (expo-router drops an undefined param), and `select` merges `day`.
  const onView = useCallback((next: CalendarView) => {
    if (next !== view) router.setParams({ view: next === 'week' ? 'week' : undefined });
  }, [router, view]);

  const toggle = useCallback((key: FilterKey) => { setFilters((current) => ({ ...current, [key]: !current[key] })); }, []);
  // None over a pending day: the kept reads would word it from reads that don't cover it.
  const tooltip = useCallback((date: string) => (input === null || !covers(date) ? null : tooltipLines(date, input)), [input, covers]);
  // How the month's forecast did (D49, design decision 11): the month view only, from the forecast read it already has.
  const monthLine = useMemo(() => (input === null || view === 'week' ? null : monthCheckLine(month, input)), [input, view, month]);

  const failure = notes.error ?? monthData.error;
  if (failure !== null) {
    return <LoadFailure error={failure} onRetry={() => { notes.reload(); monthData.reload(); calendars.reload(); }} />;
  }
  // The forecast and the calendars hold the page back only for their first read: after one answer or failure, Try
  // again, a month change and a note write keep the page showing, dimmed, with no forecast figures until it answers.
  if (input === null || shown === null || !forecast.settled || !calendars.settled) {
    return <CalendarSkeleton label="Loading the calendar" view={view} />;
  }
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const busy = monthData.busy || notes.busy || forecast.busy || !sameRange(shown.range, range);
  // After a save the forecast reads again; until it answers, the old read can't say what the note did.
  const noticeText = notice === null ? null : 'text' in notice ? notice.text
    : forecast.busy || !sameRange(input.covered, range) ? 'Saved.' : savedNotice(selected, input, notice.savedId);
  const unpublished = forecastWindow !== null && !forecastWindow.available && forecastWindow.reason === 'no_published_forecast';
  // The week view's Previous and Next move the days in view and the selected day 7 days (D64), disabled in place at the
  // 25 months' first and last blocks; the month view's step from the grid's month.
  const back = stepView(weekStart, -1, bounds, today);
  const on = stepView(weekStart, 1, bounds, today);
  /** A day of the view moved into the 25 months: a view at their first or last block holds days outside them. */
  const clampToBounds = (date: string): string => (date < `${bounds.first}-01` ? `${bounds.first}-01` : date > bounds.lastDay ? bounds.lastDay : date);
  /** Shows the days from `next` and moves the selected day `days` with them, into the new view and the 25 months. */
  const moveView = (next: string, days: number): void => {
    setStart(next);
    select(clampToBounds(followSelection(addDays(selected, days), next)), true);
  };
  const nav = view === 'week'
    ? {
      label: weekLabel(weekStart), canPrevious: back !== null, canNext: on !== null,
      onPrevious: () => { if (back !== null) moveView(back, -VIEW_DAYS); }, onNext: () => { if (on !== null) moveView(on, VIEW_DAYS); },
    }
    : {
      label: monthLabel(month), canPrevious: month > bounds.first, canNext: month < bounds.last,
      onPrevious: () => { toMonth(stepMonth(month, -1)); }, onNext: () => { toMonth(stepMonth(month, 1)); },
    };
  const failedFor = view === 'week' ? dayMonthRange(weekStart, addDays(weekStart, 6)) : MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? '';
  // One calendars notice at a time: a failed list read says so (the popover says it too, when open); a failed
  // stored-events read only while the list answered with a calendar, since with none there are no events to miss.
  const listFailed = calendars.error !== null;
  // The research banner: the location's last run, when a person started it and it was not seen yet.
  const lastRun = research.state.status === 'ready' ? research.state.data.location : null;
  const banner = seenRun !== undefined && bannerShows(lastRun, seenRun) ? bannerWords(lastRun, locationName) : null;
  const storedFailed = hasCalendars && shown.storedFailed && sameRange(shown.range, range);

  const anyFound = (shown.calendar.found ?? []).length > 0;
  const filtersNode = (
    <CalendarFilters
      filters={filters} onFilter={toggle} imported={hasCalendars} researched={anyFound || !filters.researched} chart={chartOn}
      onChart={() => { setChartOn((on) => !on); }}
    />
  );
  /** A scroll of the week stopped with `next` first in view: it follows, and so does the selected day when it left the view. */
  const onSettle = (next: string): void => {
    setStart(next);
    const follow = clampToBounds(followSelection(selected, next));
    if (follow !== selected) select(follow, true);
  };
  // The edit sheet stands on the event the 409 answered with; when the answer carried none (`stale`, the head refused),
  // on the calendar read again once it holds another head. The sheet starts again whenever its head changes.
  const foundForm = form?.mode === 'found' ? form : null;
  const foundBasis = foundForm === null ? null : foundForm.stale === null ? foundForm.event
    : (shown.calendar.found ?? []).find((event) => event.id === foundForm.event.id && event.head !== foundForm.stale) ?? foundForm.event;
  const formNode = form === null ? null : foundForm !== null && foundBasis !== null ? (
    <FoundEditForm
      key={`${foundBasis.id}:${foundBasis.head}`}
      event={foundBasis}
      conflict={foundForm.conflict}
      save={(fields) => saveFound(foundBasis, fields)}
      onCancel={() => { setForm(null); }}
    />
  ) : form.mode === 'found' ? null : (
    <NoteForm
      key={form.mode === 'edit' ? form.note.id : `${form.source}-${selected}`}
      initial={form.mode === 'edit' ? draftOf(form.note) : form.draft}
      editing={form.mode === 'edit'}
      save={save}
      onSaved={onSaved}
      onCancel={() => { setForm(null); }}
      bare
    />
  );
  /** Opens the note form from `pressed`, which anchors its popover. */
  const openForm = (next: NonNullable<FormState>, pressed: PopoverAnchor): void => {
    anchor.current = pressed.current;
    openerGone.current = false;
    setNotice(null);
    setForm(next);
  };

  const panel = (
    <MessageFocus>
      <CalendarDay
        view={dayPanel}
        locationName={locationName}
        rulesHref={locationHref(location.id, 'rules')}
        locationId={location.id}
        notice={noticeText}
        noticeResult={notice}
        noticeStays={notice !== null && 'stays' in notice}
        readOnlyId={readOnlyId}
        readOnlyText={line}
        onAdd={(pressed) => {
          openForm({ mode: 'new', draft: { ...emptyDraft('private_event'), startDate: selected, endDate: selected }, source: 'add' }, pressed);
        }}
        onEdit={(note, pressed) => { openForm({ mode: 'edit', note }, pressed); }}
        onDelete={(note) => { setStaleError(remove.error); setDeleting(note); }}
        onMakeNote={(event: ImportedEvent, pressed) => {
          openForm({
            mode: 'new', draft: draftOfImported(event), source: `${event.calendarId}:${event.uid}`,
            fromEvent: { calendarId: event.calendarId, uid: event.uid },
          }, pressed);
        }}
        onEditFound={(event, pressed) => { openForm({ mode: 'found', event, conflict: false, stale: null }, pressed); }}
        onFoundAction={foundAction}
        onAskFound={askFound}
        foundPending={foundPending}
      />
      <NotePopover
        visible={form !== null}
        anchor={anchor}
        label={form === null ? '' : formLabel(form)}
        maxWidth={400}
        dismissOnOutsidePress={false}
        busy={saving}
        onClose={() => { setForm(null); }}
        takeOpenerGone={() => {
          const went = openerGone.current;
          openerGone.current = false;
          return went;
        }}
      >
        {formNode}
      </NotePopover>
    </MessageFocus>
  );

  return (
    <View style={styles.page}>
      {unpublished ? (
        <InlineNotice
          text={`Townwise hasn’t published a forecast for ${locationName} yet. Days show your history, your notes and ${location.town.name}’s calendar. Notes you add now count as soon as a forecast is published.`}
        />
      ) : null}
      {banner === null ? null : (
        <View style={styles.banner}>
          <InlineNotice text={banner} link={{ label: BANNER_LINK, href: locationHref(location.id, 'town') }} />
          <Button
            variant="link"
            label={BANNER_DISMISS}
            accessibilityLabel={BANNER_DISMISS_LABEL}
            onPress={() => {
              if (lastRun === null) return;
              setSeenRun(runMark(lastRun));
              void markSeen(lastChatStore, me.user.id, location.id, lastRun);
            }}
          />
        </View>
      )}
      <Toolbar
        {...nav}
        onToday={() => {
          // The week view shows today's block again, today first (D40), wherever a scroll left it.
          if (view === 'week') setStart(weekStartFor(today, today));
          select(today, false, today.slice(0, 7));
        }}
        view={view}
        onView={onView}
        trailing={(
          <YourCalendars
            calendars={calendars.data?.calendars ?? null}
            google={calendars.data?.google ?? GOOGLE_OFF}
            failed={calendars.error !== null}
            reading={calendars.busy}
            onRetry={readCalendarsAgain}
            onChanged={onCalendarsChanged}
          />
        )}
      />
      {forecastFailed ? <ErrorNotice message={`Couldn’t load the forecast for ${failedFor}. Try again.`} onRetry={forecast.reload} /> : null}
      {listFailed ? <ErrorNotice message="Couldn’t load your calendars. Try again." onRetry={readCalendarsAgain} /> : null}
      {storedFailed ? <ErrorNotice message="Couldn’t load the events from your calendars. Try again." onRetry={monthData.reload} /> : null}
      <View style={desktop ? styles.split : styles.stacked}>
        {/* From 641px the filters head the grid's column, so from 1024px the panel beside it starts level with them. */}
        <View style={[styles.column, desktop ? styles.wide : null]}>
          {phone ? null : filtersNode}
          {view === 'month' && chart !== null ? <MonthChart chart={chart} selected={selected} onSelect={selectFromChart} busy={busy} /> : null}
          {/* Both views render in this slot, so the focus restore covers a switch of views too; "Your calendars" in the
              header row is outside it, and its popover floats over the page, so a switch never remounts them and a shown
              result or refusal stays. */}
          <View nativeID={SLOT_ID}>
            {view === 'week' ? (
              <CalendarWeek
                days={week}
                selected={selected}
                weekStart={weekStart}
                bounds={bounds}
                onSelect={select}
                busy={busy}
                label={weekLabel(weekStart)}
                tooltip={tooltip}
                chart={chart}
                onSettle={onSettle}
              />
            ) : (
              <CalendarGrid
                rows={rows}
                selected={selected}
                month={month}
                bounds={bounds}
                onSelect={select}
                busy={busy}
                label={monthLabel(month)}
                tooltip={tooltip}
              />
            )}
          </View>
          <FigureKey backtest={backtestShown} />
          {monthLine === null ? null : <Small>{monthLine}</Small>}
          {outlook === null ? null : <Small>{outlook}</Small>}
        </View>
        {phone ? filtersNode : null}
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
  column: { gap: theme.space[4] },
  wide: { flex: 8, minWidth: 0 },
  narrow: { flex: 4, minWidth: 0 },
  banner: { gap: theme.space[2], alignItems: 'flex-start' },
});
