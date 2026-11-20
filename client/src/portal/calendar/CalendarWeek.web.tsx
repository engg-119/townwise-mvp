import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import { ForecastPlot } from '../chart/ForecastPlot';
import { useBreakpoint } from '../hooks';
import { addDays, daysBetween } from '../locations/dates';
import { chartDrawn, chartWindows, type ChartWindow } from './chart';
import type { CalendarWeekProps } from './CalendarWeek';
import { anchorBeside, anchorOf, DayTooltip, type TooltipAnchor } from './DayTooltip.web';
import { CARD_MARK, CELL_GAP, gridHeight, gridMove, headLine, periodCard, weekHead, type InertCell, type WeekCard, type WeekDay, type WeekSlot } from './grid';
import { dottedFigure, figureTone, markedFigure, statusWord } from './model';
import { ChartKey } from './MonthChart';
import { nearestDay, stripStep, STRIP_GROW_DAYS, VIEW_DAYS } from './strip';

// The Calendar's week view on web (P28, spec 16.3, step 2): DOM, as the month grid is, because each day takes focus.
// The days scroll sideways and snap to a day (D64): one scroll container holds the strip's days (`days`, the page's
// strip, calendar/strip.ts), 7 in view, each a seventh of the view wide less its share of the 3px gaps
// (`calc((100% - 18px) / 7)`), with `scroll-snap-type: x mandatory` and each day `scroll-snap-align: start`, so touch,
// a trackpad, Shift with the wheel and the scroll bar all stop on a day's left edge. The row of days may shrink to the
// view (`min-width: 0`, and from 641px the scroller's one track is `minmax(0, 1fr)`), so its days stay a seventh of the
// view however many the strip holds. A stop is read on `scrollend`; only where a browser lacks it, 120ms after the last
// scroll event with no finger down. It is the day nearest the scroll (strip.ts nearestDay), handed to the page
// (`onSettle`), which then keeps it as the first day in view (`weekStart`). A change of `weekStart` from the page
// (Previous week, Next week, Today, a key or a `?day=` that leaves the view) scrolls there, smoothly unless reduced
// motion. Days the page adds before the first put the scroll back where the person last had it (the last scroll
// event's offset) moved by their width, in a layout effect, so nothing on screen moves; it is set, not added to, since
// Chrome re-snaps to the same day on the insert. With a chart (D64, calendar/chart.ts over the same days) each day draws
// its own slice of it (chart/ForecastPlot.tsx over the day and its neighbors, chart.ts chartWindows), so the chart's
// columns are the days' and scroll with them; under the days, the key of what the 7 days in view draw and the scale
// (MonthChart.tsx ChartKey).
// Each day is memoized, so a hover, a tooltip or a settle redraws only what changed.
// From 641px the strip is a role="grid" named by the week label with one row of every rendered day's column, each a
// full-height gridcell, the click target and the roving tab stop, labeled as its month cell (so both views say the
// same) and described by its card list, which holds the hours, terms and rules the label leaves out; the 7 in view
// carry `data-view`. A column: the chart's slice, then its head: the day ("Mon 16", "Tue Dec 1" on a month's 1st, a
// Today tag under today), the status word, the figure with "+70" (an actual solid, a forecast lighter after a "~", D49
// decision 10), and under a forecast one line, "forecast" with its range. Then every item on the day as a card
// (grid.ts buildWeek), not focusable; the panel keeps the actions. The selected column has a 2px `mint` outline over
// the `state` fill (D64), and a focused column's ring is drawn inside it, so the scroller never clips it. The box is at
// least as tall as the month grid at the same width, so switching views keeps the page height. Keys are grid.ts
// gridMove's in its 'week' layout, Home and End going to the first and last day in view, and the moved-to column takes
// focus without scrolling. When the selected day moves while a column has focus (a scroll stopped and the selection
// followed the view), focus moves to it, so the next key starts from the day in view. A mouse or pen over a column head
// shows the day's tooltip beside the column (above or below the row in the agenda), never over the day; cards and touch
// show none. An inert day (outside the 25 months) is its head line only, with no data-date; a pending day (its reads in
// flight) is its head line only, still the tab stop when selected, with no description and no tooltip.
// At 640px and below the strip is aria-hidden and out of the tab order (tabIndex -1), each day its chart slice and a
// short head (weekday, date, figure or status word) that a press selects, and the role="grid" under it is an agenda of
// the 7 days in view, a row each, every day's head on one line above its full-width cards, so Up and Down move a day,
// as a screen reader hears the next row; its height follows what it holds.

const C = theme.color;

// The scroll and its snap live in the stylesheet: the scroller scrolls sideways only and stops on a day's left edge,
// and its row, which may shrink to the view, lays the days out a seventh of the view wide less their share of the 3px
// gaps. A focused column's ring sits inside its border.
const CSS = [
  '.tw-cw [data-date],.tw-cw [data-strip]{cursor:pointer}',
  `@media (hover:hover){.tw-cw [data-date]:hover:not([data-sel="1"]),.tw-cw [data-strip]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
  '.tw-cw [data-scroller]{overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;overscroll-behavior-x:contain;scrollbar-width:thin}',
  `.tw-cw [data-strip-row]{display:grid;min-width:0;grid-auto-flow:column;grid-auto-columns:calc((100% - ${String(CELL_GAP * (VIEW_DAYS - 1))}px) / ${String(VIEW_DAYS)});gap:${String(CELL_GAP)}px}`,
  '.tw-cw [data-strip-row]>*{scroll-snap-align:start}',
  '#tw-portal .tw-cw [role="gridcell"]:focus-visible{outline-offset:-4px}',
].join('\n');

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;
const small = { fontFamily: theme.font.mono, fontSize: 10, lineHeight: '14px' } as const;
/** D72: a backtest's figure, dotted underneath (model.ts dottedFigure). */
const dotted = { textDecorationLine: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 } as const;
const sans = { fontFamily: theme.font.sans, fontSize: 12, lineHeight: '16px' } as const;

/** How long a pointer may rest over no head before the tooltip clears, as the month grid's. */
const CLEAR_DELAY_MS = 80;
/** Where `scrollend` is missing, a scroll has stopped once no scroll event came for this long. */
const SETTLE_MS = 120;
/** The chart's height atop a column, and in the phone's strip. */
const CHART_HEIGHT = 96;
const STRIP_CHART_HEIGHT = 72;
/** A day's width until the view is measured, so the chart's slices still draw. */
const START_DAY = 100;

function dateOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-date]') : null;
  return element?.getAttribute('data-date') ?? null;
}

/** Whether the browser sends `scrollend`, so a stop is never guessed from a pause in a held gesture. */
function hasScrollEnd(): boolean {
  return typeof window !== 'undefined' && 'onscrollend' in window;
}

/** The selected day's frame (D64): a 2px `mint` outline (its border and an inset ring) over the `state` fill. */
function frame(selected: boolean): React.CSSProperties {
  return selected
    ? { backgroundColor: C.state, borderColor: C.mint, boxShadow: `inset 0 0 0 1px ${C.mint}` }
    : { backgroundColor: C.raised, borderColor: C.raised };
}

/**
 * One card: its hours first when timed (mono 10), the title in full (sans 12/16), then its kind words (mono 10,
 * `text3`), on a `panel` fill with a 2px left rule in its mark's token. A term or season keeps its title and kind
 * words on one run, which wraps as every card's words do, so nothing is cut. The spaces between the parts aren't
 * drawn (the card is a grid) but keep the words apart in the column's description.
 */
function Card(props: { card: WeekCard }): React.JSX.Element {
  const { card } = props;
  const box = { display: 'grid', gap: 2, minWidth: 0, padding: '4px 6px', backgroundColor: C.panel, borderLeft: `2px solid ${C[CARD_MARK[card.kind]]}` } as const;
  if (periodCard(card)) {
    return (
      <div role="listitem" style={box}>
        <span style={{ ...sans, color: C.text2, overflowWrap: 'anywhere' }}>{card.title}{' '}<span style={{ ...small, color: C.text3 }}>{card.sub}</span></span>
      </div>
    );
  }
  return (
    <div role="listitem" style={box}>
      {card.hours === null ? null : <span style={{ ...small, color: C.text2 }}>{card.hours}</span>}
      {card.hours === null ? null : ' '}
      <span style={{ ...sans, color: C.white, overflowWrap: 'anywhere' }}>{card.title}</span>
      {' '}
      <span style={{ ...small, color: C.text3, overflowWrap: 'anywhere' }}>{card.sub}</span>
    </div>
  );
}

/** The day's head line: “Mon 16”, in `text3` for an inert day, today's in `white`, 600. */
function DayName(props: { date: string; today: boolean; inert: boolean }): React.JSX.Element {
  return (
    <span style={{ ...mono, color: props.today ? C.white : props.inert ? C.text3 : C.text2, fontWeight: props.today ? 600 : 400 }}>
      {weekHead(props.date)}
    </span>
  );
}

/**
 * A day's head: its day line, the Today tag, the status word, the figure with “+70”, and the range line; stacked in a
 * column, on one wrapping line in the agenda.
 */
function Head(props: { day: WeekDay; agenda: boolean }): React.JSX.Element {
  const { day } = props;
  const status = statusWord(day.status);
  const last = headLine(day);
  const layout = props.agenda
    ? { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2 } as const
    : { display: 'grid', gap: 2, justifyItems: 'start' } as const;
  return (
    <div aria-hidden="true" {...(day.pending ? {} : { 'data-head': '1' })} style={{ ...layout, minWidth: 0 }}>
      <DayName date={day.date} today={day.isToday} inert={false} />
      {day.isToday ? <span style={{ ...small, color: C.white, border: `1px solid ${C.line}`, padding: '0 4px' }}>Today</span> : null}
      {day.pending ? null : (
        <>
          {status === null ? null : <span style={{ ...small, color: C.text2, textTransform: 'uppercase' }}>{status}</span>}
          {day.figure === null ? null : (
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span
                data-figure={dottedFigure(day.figure) ? 'backtest' : figureTone(day.figure) === 'white' ? 'actual' : 'forecast'}
                style={{ ...mono, fontSize: 22, lineHeight: '26px', fontWeight: 500, color: C[figureTone(day.figure)], ...(dottedFigure(day.figure) ? dotted : {}) }}
              >
                {markedFigure(String(day.figure.value), day.figure)}
              </span>
              {day.noteGuests > 0 ? <span style={{ ...mono, color: C.mint }}>{`+${String(day.noteGuests)}`}</span> : null}
            </span>
          )}
          {last === null ? null : <span style={{ ...mono, fontSize: 11, lineHeight: '14px', color: C.text3 }}>{last}</span>}
        </>
      )}
    </div>
  );
}

/**
 * A day's slice of the chart: its own column of the plot over the day and its neighbors, aria-hidden, today's shaded
 * and the selected one tinted `mint`. `bleed`: the box's padding the slice reaches over, so the chart runs to the
 * column's border.
 */
const ChartSlice = memo(function ChartSlice(props: { plot: ChartWindow; width: number; height: number; selected: boolean; bleed: number }): React.JSX.Element {
  const { plot } = props;
  return (
    <div aria-hidden="true" data-chart="1" style={{ height: props.height, minWidth: 0, margin: `0 -${String(props.bleed)}px` }}>
      <ForecastPlot
        days={plot.days}
        top={plot.top}
        width={props.width - 2}
        height={props.height}
        from={plot.at}
        to={plot.at + 1}
        shaded={plot.days[plot.at]?.isToday === true ? plot.at : null}
        chosen={props.selected ? plot.at : null}
      />
    </div>
  );
});

interface ColumnProps { day: WeekDay; selected: boolean; inView: boolean; listId: string; agenda: boolean; plot: ChartWindow | null; plotWidth: number }

/** A day's column (an agenda row's one cell): the chart's slice, its head, then its card list, which describes it. */
const Column = memo(function Column(props: ColumnProps): React.JSX.Element {
  const { day } = props;
  const described = !day.pending && day.cards.length > 0;
  return (
    <div
      role="gridcell"
      data-date={day.date}
      {...(props.selected ? { 'data-sel': '1' } : {})}
      {...(props.inView && !props.agenda ? { 'data-view': '1' } : {})}
      aria-label={day.label}
      aria-selected={props.selected}
      {...(described ? { 'aria-describedby': props.listId } : {})}
      tabIndex={props.selected ? 0 : -1}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, boxSizing: 'border-box', padding: 6,
        borderWidth: 1, borderStyle: 'solid', ...frame(props.selected),
      }}
    >
      {props.plot === null ? null : <ChartSlice plot={props.plot} width={props.plotWidth} height={CHART_HEIGHT} selected={props.selected} bleed={6} />}
      <Head day={day} agenda={props.agenda} />
      {described ? (
        <div role="list" id={props.listId} style={{ display: 'grid', gap: 4, alignContent: 'start', minWidth: 0 }}>
          {day.cards.map((card, at) => [at > 0 ? ' ' : null, <Card key={card.key} card={card} />])}
        </div>
      ) : null}
    </div>
  );
});

const InertColumn = memo(function InertColumn(props: { day: InertCell; inView: boolean; agenda: boolean }): React.JSX.Element {
  return (
    <div
      role="gridcell"
      aria-disabled="true"
      aria-label={props.day.label}
      {...(props.inView && !props.agenda ? { 'data-view': '1' } : {})}
      style={{
        minWidth: 0, boxSizing: 'border-box', padding: 6, borderWidth: 1, borderStyle: 'solid', borderColor: C.border,
      }}
    >
      <span aria-hidden="true"><DayName date={props.day.date} today={false} inert /></span>
    </div>
  );
});

/** A day of the phone's strip: its chart slice and a short head (weekday, date, figure or status word), aria-hidden. */
const StripDay = memo(function StripDay(props: { day: WeekSlot; selected: boolean; plot: ChartWindow | null; plotWidth: number }): React.JSX.Element {
  const { day } = props;
  const inert = day.kind === 'inert';
  const status = inert || day.pending ? null : statusWord(day.status);
  const figure = inert || day.pending ? null : day.figure;
  return (
    <div
      {...(inert ? {} : { 'data-strip': day.date })}
      {...(props.selected ? { 'data-sel': '1' } : {})}
      style={{
        display: 'grid', gap: 2, justifyItems: 'center', minWidth: 0, boxSizing: 'border-box', padding: '4px 0', borderWidth: 1, borderStyle: 'solid',
        ...(inert ? { borderColor: C.border, backgroundColor: 'transparent' } : frame(props.selected)),
      }}
    >
      {props.plot === null ? null : (
        <div style={{ width: '100%' }}>
          <ChartSlice plot={props.plot} width={props.plotWidth} height={STRIP_CHART_HEIGHT} selected={props.selected} bleed={0} />
        </div>
      )}
      <span style={{ ...small, color: !inert && day.isToday ? C.white : C.text3, fontWeight: !inert && day.isToday ? 600 : 400 }}>{weekHead(day.date)}</span>
      {figure === null ? null : (
        <span style={{ ...mono, fontWeight: 500, color: C[figureTone(figure)], ...(dottedFigure(figure) ? dotted : {}) }}>{markedFigure(String(figure.value), figure)}</span>
      )}
      {figure !== null || status === null ? null : <span style={{ ...small, fontSize: 9, color: C.text2, textTransform: 'uppercase', textAlign: 'center' }}>{status}</span>}
    </div>
  );
});

export function CalendarWeek(props: CalendarWeekProps): React.JSX.Element {
  const { days, selected, onSelect, tooltip, weekStart, onSettle } = props;
  const chart = props.chart ?? null;
  const { width, phone } = useBreakpoint();
  const reduced = useReducedMotion();
  // At 640px and below each day is a row, so Up and Down move a day there.
  const layout = phone ? 'agenda' : 'week';
  const ids = useId().replace(/:/g, '');
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /** The view's measured width; 0 until measured (and in a test's DOM). */
  const [viewport, setViewport] = useState(0);
  /** The day whose column takes focus after this render: a key moved there. */
  const focusNext = useRef<string | null>(null);
  const [tip, setTip] = useState<{ date: string; anchor: TooltipAnchor } | null>(null);
  /** Cancels the clear waiting to run, if any. */
  const pending = useRef<(() => void) | null>(null);
  /** The first day rendered and the first day in view, as the last layout saw them. */
  const placed = useRef<{ first: string; start: string; step: number } | null>(null);
  /** The scroll the person last had (the last scroll event's or layout's offset) and the first day rendered then. */
  const scrolled = useRef<{ first: string; left: number } | null>(null);
  const lines = tip === null ? null : tooltip(tip.date);
  const step = stripStep(viewport);
  const dayWidth = step > 0 ? step - CELL_GAP : START_DAY;
  const first = days[0]?.date ?? weekStart;
  /** The first day rendered, for the scroll listener, which outlives renders. */
  const firstNow = useRef(first);
  const startIndex = Math.max(0, days.findIndex((day) => day.date === weekStart));
  const last = addDays(weekStart, VIEW_DAYS - 1);
  const inView = (date: string): boolean => date >= weekStart && date <= last;
  const windows = useMemo(() => (chart === null ? null : chartWindows(chart)), [chart]);
  const plotOf = (date: string): ChartWindow | null => windows?.get(date) ?? null;
  // The key names what the 7 days in view draw.
  const drawn = useMemo(() => (chart === null ? null : chartDrawn(chart.days.filter((day) => day.date >= weekStart && day.date <= last))), [chart, weekStart, last]);

  // The view's width, kept as it changes.
  useEffect(() => {
    const element = strip.current;
    if (element === null) return undefined;
    setViewport(element.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => { setViewport(element.clientWidth); });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [phone]);

  // Keep the view where the page says. Days added before the first put back the scroll the person last had, moved by
  // their width (nothing on screen moves): set, not added to, since a browser that re-snaps on the insert has already
  // moved it. Then a new first day in view scrolls there, smoothly unless reduced motion or a jump of more than 3 weeks.
  // A new scroller (the layout changed at 640px) starts over.
  useLayoutEffect(() => { placed.current = null; scrolled.current = null; }, [phone]);
  useLayoutEffect(() => {
    const element = strip.current;
    firstNow.current = first;
    if (element === null || step <= 0) return;
    const before = placed.current;
    placed.current = { first, start: weekStart, step };
    const seen = scrolled.current;
    if (before?.step === step && seen !== null && seen.first !== first) element.scrollLeft = seen.left + daysBetween(first, seen.first) * step;
    const target = startIndex * step;
    if (Math.abs(element.scrollLeft - target) > 1) {
      // At once on the first layout, a new width, a jump of more than 3 weeks, or under reduced motion.
      const jump = before?.step !== step || Math.abs(daysBetween(before.start, weekStart)) > STRIP_GROW_DAYS || reduced !== false;
      if (jump || typeof element.scrollTo !== 'function') element.scrollLeft = target;
      else element.scrollTo({ left: target, behavior: 'smooth' });
    }
    scrolled.current = { first, left: element.scrollLeft };
  }, [first, weekStart, startIndex, step, reduced]);

  // A scroll's stop: the day nearest the scroll, read on scrollend; where it is missing, once scroll events stop with
  // no finger down.
  const settle = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    settle.current = (): void => {
      const element = strip.current;
      if (element === null || onSettle === undefined) return;
      const day = days[nearestDay(element.scrollLeft, step, days.length)];
      if (day !== undefined && day.date !== weekStart) onSettle(day.date);
    };
  });
  useEffect(() => {
    const element = strip.current;
    if (element === null) return undefined;
    const ends = hasScrollEnd();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let touching = false;
    const clear = (): void => { if (timer !== null) clearTimeout(timer); timer = null; };
    const arm = (): void => {
      clear();
      if (!ends && !touching) timer = setTimeout(() => { timer = null; settle.current(); }, SETTLE_MS);
    };
    const onScroll = (): void => {
      scrolled.current = { first: firstNow.current, left: element.scrollLeft };
      arm();
    };
    const onEnd = (): void => { clear(); settle.current(); };
    const onTouchStart = (): void => { touching = true; clear(); };
    const onTouchEnd = (): void => { touching = false; arm(); };
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('scrollend', onEnd);
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      clear();
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('scrollend', onEnd);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [phone]);

  useEffect(() => {
    const date = focusNext.current;
    if (date === null || box.current === null) return;
    const cell = box.current.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`);
    if (cell === null) return;
    focusNext.current = null;
    cell.focus({ preventScroll: true });
  });

  // Focus on another day's column follows the selected day (a scroll stopped and the selection followed the view), so
  // a key then moves from the day in view rather than pulling the view back to the old one.
  useEffect(() => {
    const root = box.current;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (root === null || !(active instanceof HTMLElement) || !root.contains(active)) return;
    const from = dateOf(active.closest('[role="gridcell"]'));
    if (from === null || from === selected) return;
    root.querySelector<HTMLElement>(`[role="grid"] [data-date="${selected}"]`)?.focus({ preventScroll: true });
  }, [selected]);

  function cancelClear(): void {
    pending.current?.();
    pending.current = null;
  }

  function clearSoon(): void {
    if (pending.current !== null) return;
    const id = setTimeout(() => { pending.current = null; setTip(null); }, CLEAR_DELAY_MS);
    pending.current = () => { clearTimeout(id); };
  }

  useEffect(() => cancelClear, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const from = dateOf(event.target);
    if (from === null) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(from);
      return;
    }
    const next = gridMove(from, event.key, event.ctrlKey || event.metaKey, { layout, weekStart, bounds: props.bounds });
    if (next === null) return;
    event.preventDefault();
    // Consumed: the move would leave the 25 months.
    if (next.date === from && next.month === null) return;
    cancelClear();
    setTip(null);
    focusNext.current = next.date;
    onSelect(next.date, true, next.month);
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const date = dateOf(event.target);
    if (date !== null) onSelect(date);
  }

  // A press on the phone's strip never leaves focus inside it (it is aria-hidden): its mousedown is prevented, and focus
  // goes to the day's agenda row, as a press there leaves it, so the arrow keys go on from it; a day out of view has
  // its row focused once the page brings it into view.
  function onStripMouseDown(event: React.MouseEvent<HTMLDivElement>): void {
    if (event.target instanceof Element && event.target.closest('[data-strip]') !== null) event.preventDefault();
  }

  function onStripClick(event: React.MouseEvent<HTMLDivElement>): void {
    const element = event.target instanceof Element ? event.target.closest('[data-strip]') : null;
    const date = element?.getAttribute('data-strip') ?? null;
    if (date === null) return;
    const row = box.current?.querySelector<HTMLElement>(`[role="grid"] [data-date="${date}"]`) ?? null;
    if (row === null) focusNext.current = date;
    else row.focus({ preventScroll: true });
    onSelect(date);
  }

  // Over a column's head only: a card, a gap or a pending or inert day clears the tooltip.
  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const head = event.target instanceof Element ? event.target.closest('[data-head]') : null;
    const date = head === null ? null : dateOf(head);
    if (head === null || date === null) { clearSoon(); return; }
    cancelClear();
    if (date === tip?.date || box.current === null) return;
    // Never over the day itself: beside its column, or above or below its row in the agenda.
    const column = head.closest('[role="gridcell"]') ?? head;
    setTip({ date, anchor: phone ? anchorOf(column, box.current) : anchorBeside(column, box.current) });
  }

  function onPointerLeave(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    cancelClear();
    setTip(null);
  }

  const dayOf = (day: WeekSlot): React.JSX.Element => (day.kind === 'inert'
    ? <InertColumn key={day.date} day={day} inView={inView(day.date)} agenda={phone} />
    : (
      <Column
        key={day.date}
        day={day}
        selected={day.date === selected}
        inView={inView(day.date)}
        listId={`${ids}-cards-${day.date}`}
        agenda={phone}
        plot={phone ? null : plotOf(day.date)}
        plotWidth={dayWidth}
      />
    ));

  const grid = {
    role: 'grid', 'aria-label': props.label, 'aria-readonly': true, 'aria-busy': props.busy,
    onKeyDown, onClick, onPointerOver, onPointerLeave,
  } as const;
  const key = chart === null || drawn === null ? null : <ChartKey drawn={drawn} top={chart.top} testID="calendar-week-chart-key" />;

  return (
    <div ref={box} className="tw-cw" style={{ position: 'relative', width: '100%', display: 'grid', gap: CELL_GAP, opacity: props.busy ? 0.6 : 1 }}>
      <style href="townwise-calendar-week" precedence="default">{CSS}</style>
      {phone ? (
        <>
          <div ref={strip} data-scroller="1" aria-hidden="true" tabIndex={-1} onMouseDown={onStripMouseDown} onClick={onStripClick}>
            <div data-strip-row="1">
              {days.map((day) => (
                <StripDay key={day.date} day={day} selected={day.date === selected} plot={plotOf(day.date)} plotWidth={dayWidth} />
              ))}
            </div>
          </div>
          {key}
          <div {...grid} style={{ display: 'grid', gap: CELL_GAP }}>
            {days.filter((day) => inView(day.date)).map((day) => <div key={day.date} role="row" style={{ display: 'grid' }}>{dayOf(day)}</div>)}
          </div>
        </>
      ) : (
        <>
          <div ref={strip} data-scroller="1" {...grid} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minHeight: gridHeight(width) }}>
            <div role="row" data-strip-row="1">{days.map(dayOf)}</div>
          </div>
          {key}
        </>
      )}
      {tip === null || lines === null ? null : <DayTooltip tip={lines} anchor={tip.anchor} />}
    </div>
  );
}
