import { useEffect, useRef, useState } from 'react';

import { theme } from '../../../theme';
import { monthMove, WIDE_CELL_HEIGHT, WIDE_ROWS } from '../../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../../analytics/words';
import { anchorOf, DayTooltip, type TooltipAnchor } from '../../calendar/DayTooltip.web';
import type { EventMonthProps } from './EventMonth';
import { cellLines, dayTooltip, TITLE_MIN_SHARE, type EventDay, type MonthEntry } from './eventDays';
import { EventMonthKey } from './EventMonthKey';

// A calendar's events as a month grid on web (D62): DOM, as Home's month grid is (home/MonthGrid.web.tsx), because
// each day takes focus. The grid is role="grid" named by the calendar and month, and one tab stop (roving tabIndex on
// the selected day). Left and Right move a day, Up and Down a week, Home and End the row's ends, Ctrl+Home and
// Ctrl+End the month's ends (week.ts monthMove), and the selection follows, so the day's list under the grid follows
// the keys; a click, Enter or Space selects a day. A mouse or pen over a day with events shows its tooltip (the
// Calendar's DayTooltip) with every event in full; leaving the grid, or moving over anything that is not a day, hides
// it. What a cell shows is EventMonth.tsx's; each is 96px tall whatever it holds, so the grid never changes height.

const C = theme.color;
const HEAD = WEEK_ORDER.map((day) => WEEKDAY_NAMES[day] ?? '');

// Hover is a ring, as on Home's grid: each cell's fill and border are inline styles, which a stylesheet rule can't
// override, but its box-shadow is not.
const CSS = [
  '.tw-em [data-date]{cursor:pointer}',
  `@media (hover:hover){.tw-em [data-date]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
].join('\n');

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;
const row = { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 } as const;
/** An entry line: one line, cut with an ellipsis; the day's label says it whole. */
const entryLine = {
  display: 'block', fontFamily: theme.font.sans, fontSize: 11, lineHeight: `${String(WIDE_ROWS.entry)}px`, color: C.text2,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
} as const;
/**
 * An event's line: its time, tag and title side by side, the title keeping TITLE_MIN_SHARE of the line, so a long tag
 * gives way first (cut with an ellipsis) and the time never. The gap spaces them; each part's trailing space, which a
 * flex item drops, keeps the cell's text as words for find and copy.
 */
const entryRow = { ...entryLine, display: 'flex', alignItems: 'baseline', columnGap: 4 } as const;
const cut = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const;
const smallMono = { fontFamily: theme.font.mono, fontSize: 10 } as const;
/** Today's number, filled in the primary button's colors so it reads apart from the selected day's mint outline. */
const TODAY_BADGE = { color: C.onCta, backgroundColor: C.cta, fontWeight: 600, padding: '0 5px', borderRadius: 2 } as const;

/** How long a pointer may rest over no day (the gap between cells) before the tooltip clears. */
const CLEAR_DELAY_MS = 80;

function dateOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-date]') : null;
  return element?.getAttribute('data-date') ?? null;
}

function Line(props: { entry: MonthEntry }): React.JSX.Element {
  const { entry } = props;
  return (
    <span style={entryRow}>
      {entry.time === null ? null : <span style={{ ...smallMono, color: C.text3, flexShrink: 0 }}>{entry.time} </span>}
      {entry.tag === null ? null : (
        <span data-tag="" style={{ ...smallMono, ...cut, color: C.white, textTransform: 'uppercase', flex: '0 1 auto' }}>{entry.tag} </span>
      )}
      <span style={{ ...cut, flex: `1 0 ${TITLE_MIN_SHARE}` }}>{entry.title}</span>
    </span>
  );
}

function Day(props: { day: EventDay; selected: boolean }): React.JSX.Element {
  const { day } = props;
  const { lines, more } = cellLines(day.entries);
  return (
    <div
      role="gridcell"
      data-date={day.date}
      {...(props.selected ? { 'data-sel': '1' } : {})}
      aria-label={day.label}
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      style={{
        position: 'relative', minWidth: 0, boxSizing: 'border-box', padding: 4, height: WIDE_CELL_HEIGHT, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: WIDE_ROWS.gap,
        background: C.raised, border: `1px solid ${props.selected ? C.mint : C.raised}`,
      }}
    >
      <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', height: WIDE_ROWS.top, flexShrink: 0 }}>
        <span style={day.isToday ? { ...mono, fontSize: 13, ...TODAY_BADGE } : { ...mono, fontSize: 13, color: C.text2 }}>
          {String(Number(day.date.slice(8, 10)))}
        </span>
      </span>
      <span aria-hidden="true" style={{ display: 'grid', gap: WIDE_ROWS.entryGap, minWidth: 0 }}>
        {lines.map((entry) => <Line key={entry.key} entry={entry} />)}
        {more === null ? null : <span style={{ ...entryLine, color: C.text3 }}>{more}</span>}
      </span>
    </div>
  );
}

export function EventMonth(props: EventMonthProps): React.JSX.Element {
  const { rows, selected, onSelect } = props;
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ date: string; anchor: TooltipAnchor } | null>(null);
  /** The day whose cell takes focus after this render: a key moved there. */
  const focusNext = useRef<string | null>(null);
  /** Cancels the clear waiting for the delay, if any. */
  const pending = useRef<(() => void) | null>(null);
  const tipDay = tip === null ? null : rows.flat().find((day) => day?.date === tip.date) ?? null;
  const lines = tipDay === null ? null : dayTooltip(tipDay);

  useEffect(() => {
    const date = focusNext.current;
    if (date === null || root.current === null) return;
    const cell = root.current.querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (cell === null) return;
    focusNext.current = null;
    cell.focus();
  });

  function cancelClear(): void {
    pending.current?.();
    pending.current = null;
  }

  // Crossing the 3px gap between two days is over no day for a moment: the clear waits, and entering a day before it
  // runs cancels it, so the tooltip does not blink.
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
    const next = monthMove(from, event.key, event.ctrlKey || event.metaKey);
    if (next === null) return;
    event.preventDefault();
    cancelClear();
    setTip(null);
    // A key past the month's edge keeps the day, and selecting the selected day renders nothing: a request left here
    // would take focus back from wherever it is on the grid's next render (a hover, a label set under the grid).
    focusNext.current = next === from ? null : next;
    onSelect(next);
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const date = dateOf(event.target);
    if (date !== null) onSelect(date);
  }

  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const date = dateOf(event.target);
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
    <div className="tw-em" style={{ display: 'grid', gap: 12, width: '100%' }}>
      <style href="townwise-event-month" precedence="default">{CSS}</style>
      <div ref={box} style={{ position: 'relative', opacity: props.busy === true ? 0.6 : 1 }}>
        <div
          ref={root}
          role="grid"
          aria-label={props.label}
          aria-readonly
          aria-busy={props.busy === true}
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
              {cells.map((day, col) => (day === null
                ? <div key={col} role="gridcell" />
                : <Day key={day.date} day={day} selected={day.date === selected} />))}
            </div>
          ))}
        </div>
        {tip === null || lines === null ? null : <DayTooltip tip={lines} anchor={tip.anchor} />}
      </div>
      <EventMonthKey />
    </div>
  );
}
