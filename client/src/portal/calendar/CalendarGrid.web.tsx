import { useEffect, useRef, useState } from 'react';

import { theme } from '../../theme';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { useBreakpoint } from '../hooks';
import { MARK } from '../home/MonthKey';
import type { CalendarGridProps } from './CalendarGrid';
import { anchorOf, DayTooltip, type TooltipAnchor } from './DayTooltip.web';
import { CELL_GAP, cellSize, entryLines, gridMove, slotOf, WEEKDAY_ROW, type DayCell } from './grid';
import { captionOf, figureTone, markedFigure, statusWord } from './model';

// The Calendar's month grid on web (P28, spec 16.3): DOM, as Home's month grid is, because each day
// takes focus. The grid is role="grid" named by its month and one tab stop (roving tabIndex on the selected day).
// Left and Right move a day and Up and Down a week, across rows and months; Home and End the row's ends, Ctrl+Home
// and Ctrl+End the grid month's ends, PageUp and PageDown the month before or after (grid.ts gridMove). A key past the
// 25 months is consumed. The selection follows, and the moved-to cell takes focus. A click, Enter or Space selects a
// day; a leading or trailing day is selected in place, so the grid stays on its month. A mouse or pen over a day
// shows its tooltip (one delegated handler; touch never does); leaving the grid, or moving over anything that is not a day
// (a gap, the weekday row, an inert day), hides it. Hover and the pointer live in one React-rendered stylesheet; the
// focus ring is the portal's. What a cell shows is CalendarGrid.tsx's: each cell is a fixed height by width
// (grid.ts cellSize), whatever it holds, so the grid never changes height.

const C = theme.color;
const HEAD = WEEK_ORDER.map((day) => WEEKDAY_NAMES[day] ?? '');

// Hover is a ring: each cell's fill and border are inline styles, which a stylesheet rule can't override, but its
// box-shadow is not.
const CSS = [
  '.tw-cg [data-date]{cursor:pointer}',
  `@media (hover:hover){.tw-cg [data-date]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
].join('\n');

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;
const small = { fontFamily: theme.font.mono, fontSize: 10, lineHeight: '14px' } as const;
const square = { position: 'absolute', width: MARK, height: MARK, pointerEvents: 'none' } as const;
const row = { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: CELL_GAP } as const;
const line = { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const block = { display: 'block' } as const;

function dateOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-date]') : null;
  return element?.getAttribute('data-date') ?? null;
}

/** Runs `run` after the clear delay; the returned function cancels it. One animation frame is too short: the next day's pointerover often lands a frame later. */
function nextFrame(run: () => void): () => void {
  const id = setTimeout(run, CLEAR_DELAY_MS);
  return () => { clearTimeout(id); };
}

/** How long a pointer may rest over no day (the gap between cells) before the tooltip clears. */
const CLEAR_DELAY_MS = 80;

/** “Likely closed” over two lines, “LIKELY” over “CLOSED” once uppercased; the space keeps the words apart in the text. */
function StatusWords(props: { words: string; size: number; color: string }): React.JSX.Element {
  return (
    <span style={{ fontFamily: theme.font.mono, fontSize: props.size, lineHeight: `${String(props.size + 2)}px`, color: props.color, textTransform: 'uppercase', textAlign: 'center' }}>
      {props.words.split(' ').map((word, at) => <span key={at} style={block}>{at > 0 ? ' ' : null}{word}</span>)}
    </span>
  );
}

/** A day's cell: its number row, then its figure or status word, then its entry lines from 1024px or its corner marks. */
function Day(props: { cell: DayCell; selected: boolean; width: number }): React.JSX.Element {
  const { cell } = props;
  const size = cellSize(props.width);
  const phone = props.width <= 640;
  const muted = cell.outside;
  const status = statusWord(cell.status);
  // Below 641px every status takes the figure's place; above it a booked day says so in its top row, over its party.
  const statusInFigure = status !== null && (phone || cell.status !== 'booked');
  const topRight = phone || cell.pending ? null : cell.status === 'booked' ? status : captionOf(cell);
  const entries = entryLines(cell);
  const border = props.selected ? C.mint : cell.inWeek ? C.line : muted ? C.border : C.raised;
  return (
    <div
      role="gridcell"
      data-date={cell.date}
      {...(props.selected ? { 'data-sel': '1' } : {})}
      {...(muted ? { 'data-outside': '1' } : {})}
      aria-label={cell.label}
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      style={{
        position: 'relative', height: size.height, minWidth: 0, boxSizing: 'border-box', padding: 4, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 2,
        backgroundColor: muted ? 'transparent' : C.raised, borderWidth: 1, borderStyle: 'solid', borderColor: border,
      }}
    >
      <span aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4, height: 16, flexShrink: 0 }}>
        <span style={{ ...mono, fontSize: 13, color: cell.isToday ? C.white : muted ? C.text3 : C.text2, fontWeight: cell.isToday ? 600 : 400 }}>
          {String(Number(cell.date.slice(8, 10)))}
        </span>
        {topRight === null ? null : <span style={{ ...small, color: muted ? C.text3 : C.text2, textTransform: 'uppercase' }}>{topRight}</span>}
      </span>
      {cell.pending ? null : (
        <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, flexShrink: 0, ...(size.lines > 0 ? { height: 26 } : {}) }}>
          {statusInFigure ? <StatusWords words={status} size={phone ? 9 : 10} color={muted ? C.text3 : C.text2} /> : cell.figure === null ? null : (
            <>
              <span data-figure={figureTone(cell.figure) === 'white' ? 'actual' : 'forecast'} style={{ ...mono, fontSize: size.figure, lineHeight: `${String(size.figure + 4)}px`, fontWeight: 500, color: muted ? C.text3 : C[figureTone(cell.figure)] }}>
                {markedFigure(String(cell.figure.value), cell.figure)}
              </span>
              {cell.noteGuests > 0 && !phone ? <span style={{ ...mono, color: C.mint }}>{`+${String(cell.noteGuests)}`}</span> : null}
            </>
          )}
        </span>
      )}
      {cell.pending ? null : size.lines > 0 ? (
        <span aria-hidden="true" style={{ display: 'grid', alignContent: 'start', gap: 2, height: 46, minWidth: 0, flexShrink: 0 }}>
          {entries.lines.map((entry, at) => <span key={at} style={{ ...small, ...line, fontSize: 11, color: muted ? C.text3 : C.text2 }}>{entry}</span>)}
          {entries.more === null ? null : <span style={{ ...small, ...line, color: C.text3 }}>{entries.more}</span>}
        </span>
      ) : (
        <>
          {cell.marks.event ? <span aria-hidden="true" style={{ ...square, top: 0, right: 0, background: C.white }} /> : null}
          {cell.marks.note ? <span aria-hidden="true" style={{ ...square, bottom: 0, left: 0, background: C.text2 }} /> : null}
          {cell.marks.imported ? (
            <span aria-hidden="true" style={{ ...square, bottom: 0, right: 0, width: MARK + 2, height: MARK + 2, boxSizing: 'border-box', border: `1px solid ${C.mint}` }} />
          ) : null}
        </>
      )}
    </div>
  );
}

export function CalendarGrid(props: CalendarGridProps): React.JSX.Element {
  const { rows, selected, onSelect, tooltip } = props;
  const { width } = useBreakpoint();
  const size = cellSize(width);
  const box = useRef<HTMLDivElement>(null);
  /** The day whose cell takes focus after this render: a key moved there. */
  const focusNext = useRef<string | null>(null);
  const [tip, setTip] = useState<{ date: string; anchor: TooltipAnchor } | null>(null);
  /** Cancels the clear waiting for the next frame, if any. */
  const pending = useRef<(() => void) | null>(null);
  // Worded at render, so a tooltip open while the forecast reads again shows the new figures.
  const lines = tip === null ? null : tooltip(tip.date);

  useEffect(() => {
    const date = focusNext.current;
    if (date === null || box.current === null) return;
    const cell = box.current.querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (cell === null) return;
    focusNext.current = null;
    cell.focus();
  });

  function cancelClear(): void {
    pending.current?.();
    pending.current = null;
  }

  // Crossing the 3px gap between two days is over no day for a moment: the clear waits a frame, and entering a day
  // before it runs cancels it, so the tooltip does not blink.
  function clearSoon(): void {
    if (pending.current !== null) return;
    pending.current = nextFrame(() => { pending.current = null; setTip(null); });
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
    const next = gridMove(from, event.key, event.ctrlKey || event.metaKey, { layout: 'month', month: props.month, bounds: props.bounds });
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

  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const date = dateOf(event.target);
    // Over no day (a gap between cells, the weekday row, an empty or inert cell): the tooltip goes.
    if (date === null) { clearSoon(); return; }
    cancelClear();
    if (date === tip?.date || box.current === null) return;
    const cell = box.current.querySelector(`[data-date="${date}"]`);
    setTip(cell === null ? null : { date, anchor: anchorOf(cell, box.current) });
  }

  function onPointerLeave(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    cancelClear();
    setTip(null);
  }

  return (
    <div ref={box} className="tw-cg" style={{ position: 'relative', width: '100%', opacity: props.busy ? 0.6 : 1 }}>
      <style href="townwise-calendar-grid" precedence="default">{CSS}</style>
      <div
        role="grid"
        aria-label={props.label}
        aria-readonly
        aria-busy={props.busy}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onPointerOver={onPointerOver}
        onPointerLeave={onPointerLeave}
        style={{ display: 'grid', gap: CELL_GAP }}
      >
        <div role="row" style={row}>
          {HEAD.map((day) => (
            <div key={day} role="columnheader" aria-label={day} style={{ ...mono, lineHeight: `${String(WEEKDAY_ROW)}px`, color: C.text3, textAlign: 'center' }}>{day.slice(0, 3)}</div>
          ))}
        </div>
        {rows.map((cells, index) => (
          <div key={index} role="row" style={row}>
            {cells.map((each, col) => {
              if (each === null) return <div key={col} role="gridcell" />;
              const slot = slotOf(each);
              if (slot.kind === 'inert') {
                return (
                  <div
                    key={slot.date}
                    role="gridcell"
                    aria-disabled="true"
                    aria-label={slot.label}
                    style={{
                      height: size.height, minWidth: 0, boxSizing: 'border-box', padding: 4, overflow: 'hidden',
                      backgroundColor: 'transparent', borderWidth: 1, borderStyle: 'solid', borderColor: C.border,
                    }}
                  >
                    <span aria-hidden="true" style={{ ...mono, fontSize: 13, color: C.text3 }}>{String(Number(slot.date.slice(8, 10)))}</span>
                  </div>
                );
              }
              return <Day key={slot.date} cell={slot} selected={slot.date === selected} width={width} />;
            })}
          </div>
        ))}
      </div>
      {tip === null || lines === null ? null : <DayTooltip tip={lines} anchor={tip.anchor} />}
    </div>
  );
}
