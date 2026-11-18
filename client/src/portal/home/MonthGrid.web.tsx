import { useEffect, useRef, useState } from 'react';

import { theme } from '../../theme';
import { monthEntryLines, monthMove, WIDE_CELL_HEIGHT } from '../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import { anchorOf, DayTooltip, type TooltipAnchor } from '../calendar/DayTooltip.web';
import { figureTone, statusWord } from '../calendar/model';
import { useBreakpoint } from '../hooks';
import type { MonthGridProps } from './MonthGrid';
import { MARK, MonthKey } from './MonthKey';

// This month as a grid on web (spec P11): DOM, as the heatmap is, because each day takes focus. The grid is
// role="grid" named by its month and one tab stop (roving tabIndex on the selected day). Left and Right move a day,
// Up and Down a week, Home and End the row's ends, Ctrl+Home and Ctrl+End the month's ends (week.ts monthMove), and
// the selection follows focus, so the detail beside the grid follows the keys. A click, Enter or Space opens the day
// in the Calendar (spec 16.3 P11). A mouse or pen over a day previews it and shows its tooltip (the
// Calendar's DayTooltip; one delegated handler, touch ignored); leaving the grid, or moving over anything that is not a
// day (a gap, the weekday row, an empty cell), restores the selection. A cell
// shows its day number and figure (MonthGrid.tsx says which), as wide as its column and at least 64px tall from 641px
// (52px on phones), growing with what it holds. Its status (“Likely closed”, “Closed”, “Booked”) is its own line under
// the number, in a type that shrinks with the cell (a size container) so its longest word fits: the grid is about
// 300px wide at many widths, where a cell holds about 30px of text. Hover, the pointer and the status's size live in
// one React-rendered stylesheet, as the heatmap's do; the focus ring is the portal's.

const C = theme.color;
const HEAD = WEEK_ORDER.map((day) => WEEKDAY_NAMES[day] ?? '');

// Hover is a ring, as on the heatmap: each cell's fill and border are inline styles, which a stylesheet rule can't
// override, but its box-shadow is not.
const CSS = [
  '.tw-mg [data-date]{cursor:pointer}',
  `@media (hover:hover){.tw-mg [data-date]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
  // Each cell is the status's container. Its longest word, “LIKELY” or “CLOSED”, is 6 letters of 0.6em in Geist Mono:
  // 3.6em, so 1/3.7 of the cell keeps it inside (10px from a 37px cell). 10px where container units aren't known.
  '.tw-mg [data-date]{container-type:inline-size}',
  '.tw-mg .tw-mg-status{font-size:10px;font-size:min(10px, calc(100cqi / 3.7))}',
].join('\n');

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;
const square = { position: 'absolute', width: MARK, height: MARK, pointerEvents: 'none' } as const;
/** The status line; its size is the stylesheet's (CSS), so it is not set here. */
const statusStyle = { fontFamily: theme.font.mono, lineHeight: '12px', color: C.text2, textTransform: 'uppercase' } as const;
const row = { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 } as const;
/** A wide cell's entry line: one line, cut with an ellipsis; the cell's label says it whole. */
const entryLine = {
  fontFamily: theme.font.sans, fontSize: 11, lineHeight: '14px', color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
} as const;

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

export function MonthGrid(props: MonthGridProps): React.JSX.Element {
  const { rows, selected, onSelect, onPreview, onOpen, tooltip } = props;
  const { phone } = useBreakpoint();
  const wide = props.wide === true;
  const figureSize = phone ? 15 : 18;
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ date: string; anchor: TooltipAnchor } | null>(null);
  // Worded at render, so a tooltip open while the forecast answers shows its figures.
  const lines = tip === null ? null : tooltip(tip.date);
  /** The day whose cell takes focus after this render: a key moved there. */
  const focusNext = useRef<string | null>(null);
  const previewed = useRef<string | null>(null);
  /** Cancels the clear waiting for the next frame, if any. */
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    const date = focusNext.current;
    if (date === null || root.current === null) return;
    const cell = root.current.querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (cell === null) return;
    focusNext.current = null;
    cell.focus();
  });

  /** The keys take over from a pointer resting on a day, so the detail follows the selection. */
  function clearPreview(): void {
    setTip(null);
    if (previewed.current === null) return;
    previewed.current = null;
    onPreview(null);
  }

  function cancelClear(): void {
    pending.current?.();
    pending.current = null;
  }

  // Crossing the 3px gap between two days is over no day for a moment: the clear waits a frame, and entering a day
  // before it runs cancels it, so the preview does not flash the selected day's detail.
  function clearSoon(): void {
    if (pending.current !== null) return;
    pending.current = nextFrame(() => { pending.current = null; clearPreview(); });
  }

  useEffect(() => cancelClear, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const from = dateOf(event.target);
    if (from === null) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(from);
      return;
    }
    const next = monthMove(from, event.key, event.ctrlKey || event.metaKey);
    if (next === null) return;
    event.preventDefault();
    cancelClear();
    clearPreview();
    focusNext.current = next;
    onSelect(next);
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const date = dateOf(event.target);
    if (date !== null) onOpen(date);
  }

  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const date = dateOf(event.target);
    // Over no day (a gap, the weekday row, an empty leading cell): clear as leaving the grid does.
    if (date === null) { clearSoon(); return; }
    cancelClear();
    if (date === previewed.current) return;
    previewed.current = date;
    onPreview(date);
    const cell = box.current?.querySelector(`[data-date="${date}"]`) ?? null;
    setTip(cell === null || box.current === null ? null : { date, anchor: anchorOf(cell, box.current) });
  }

  function onPointerLeave(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    cancelClear();
    clearPreview();
  }

  return (
    <div className="tw-mg" style={{ display: 'grid', gap: 12, width: '100%' }}>
      <style href="townwise-month-grid" precedence="default">{CSS}</style>
      <div ref={box} style={{ position: 'relative' }}>
        <div
          ref={root}
          role="grid"
          aria-label={props.label}
          aria-readonly
          onKeyDown={onKeyDown}
          onClick={onClick}
          onPointerOver={onPointerOver}
          onPointerLeave={onPointerLeave}
          style={{ display: 'grid', gap: 3 }}
        >
          <div role="row" style={row}>
            {HEAD.map((day) => (
              <div key={day} role="columnheader" aria-label={day} style={{ ...mono, color: C.text3, textAlign: 'center' }}>{day.slice(0, 3)}</div>
            ))}
          </div>
          {rows.map((cells, index) => (
            <div key={index} role="row" style={row}>
              {cells.map((cell, col) => {
                if (cell === null) return <div key={col} role="gridcell" />;
                const isSelected = cell.date === selected;
                return (
                  <div
                    key={cell.date}
                    role="gridcell"
                    data-date={cell.date}
                    {...(isSelected ? { 'data-sel': '1' } : {})}
                    aria-label={cell.label}
                    aria-selected={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    style={{
                      // No aspect ratio: with one, a cell took its minimum height as its width too and overlapped the next
                      // in a grid narrower than seven of them.
                      position: 'relative', minWidth: 0, boxSizing: 'border-box', padding: '4px 2px',
                      ...(wide ? { height: WIDE_CELL_HEIGHT, overflow: 'hidden' } : { minHeight: phone ? 52 : 64 }),
                      display: 'flex', flexDirection: 'column', gap: 2,
                      background: C.raised, border: `1px solid ${isSelected ? C.mint : cell.inWeek ? C.line : C.raised}`,
                    }}
                  >
                    <span aria-hidden="true" style={{ display: 'flex' }}>
                      <span style={{ ...mono, fontSize: 13, color: cell.isToday ? C.white : C.text2, fontWeight: cell.isToday ? 600 : 400 }}>
                        {String(Number(cell.date.slice(8, 10)))}
                      </span>
                    </span>
                    {cell.status === null ? null : (
                      <span aria-hidden="true" className="tw-mg-status" style={statusStyle}>{statusWord(cell.status)}</span>
                    )}
                    {cell.figure === null ? null : (
                      <span aria-hidden="true" style={{ display: 'grid', justifyItems: 'center' }}>
                        <span data-figure={figureTone(cell.figure) === 'white' ? 'actual' : 'forecast'} style={{ ...mono, fontSize: figureSize, lineHeight: `${String(figureSize + 4)}px`, fontWeight: 500, color: C[figureTone(cell.figure)] }}>
                          {cell.figureText}
                        </span>
                        {cell.noteGuests > 0 ? <span style={{ ...mono, color: C.mint }}>{`+${String(cell.noteGuests)}`}</span> : null}
                        {cell.caption === null ? null : <span style={{ ...mono, fontSize: 10, lineHeight: '12px', color: C.text3 }}>{cell.caption}</span>}
                      </span>
                    )}
                    {wide ? (
                      <span aria-hidden="true" style={{ display: 'grid', gap: 1, minWidth: 0 }}>
                        {monthEntryLines(cell).lines.map((entry, at) => <span key={at} style={entryLine}>{entry}</span>)}
                        {monthEntryLines(cell).more === null ? null : <span style={{ ...entryLine, color: C.text3 }}>{monthEntryLines(cell).more}</span>}
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
              })}
            </div>
          ))}
        </div>
        {tip === null || lines === null ? null : <DayTooltip tip={lines} anchor={tip.anchor} />}
      </div>
      <MonthKey {...(props.metric === undefined ? {} : { metric: props.metric })} />
      {props.footer}
    </div>
  );
}
