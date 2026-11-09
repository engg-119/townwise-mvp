import { useEffect, useRef } from 'react';

import { theme } from '../../theme';
import { monthMove } from '../analytics/week';
import { WEEK_ORDER, WEEKDAY_NAMES } from '../analytics/words';
import type { MonthGridProps } from './MonthGrid';
import { MARK, MonthKey } from './MonthKey';

// This month as a grid on web (spec P11): DOM, as the heatmap is, because each day takes focus. The grid is
// role="grid" named by its month and one tab stop (roving tabIndex on the selected day). Left and Right move a day,
// Up and Down a week, Home and End the row's ends, Ctrl+Home and Ctrl+End the month's ends (week.ts monthMove), and
// the selection follows focus, so the detail beside the grid follows the keys. A click selects a day. A mouse or pen
// over a day previews it (one delegated handler, touch ignored) and leaving the grid restores the selection. Hover
// and the pointer live in one React-rendered stylesheet, as the heatmap's do; the focus ring is the portal's.

const C = theme.color;
const HEAD = WEEK_ORDER.map((day) => WEEKDAY_NAMES[day] ?? '');

// Hover is a ring, as on the heatmap: each cell's fill and border are inline styles, which a stylesheet rule can't
// override, but its box-shadow is not.
const CSS = [
  '.tw-mg [data-date]{cursor:pointer}',
  `@media (hover:hover){.tw-mg [data-date]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
].join('\n');

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;
const square = { position: 'absolute', width: MARK, height: MARK, pointerEvents: 'none' } as const;
const row = { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 } as const;

function dateOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-date]') : null;
  return element?.getAttribute('data-date') ?? null;
}

export function MonthGrid(props: MonthGridProps): React.JSX.Element {
  const { rows, selected, onSelect, onPreview } = props;
  const root = useRef<HTMLDivElement>(null);
  /** The day whose cell takes focus after this render: a key moved there. */
  const focusNext = useRef<string | null>(null);
  const previewed = useRef<string | null>(null);

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
    if (previewed.current === null) return;
    previewed.current = null;
    onPreview(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const from = dateOf(event.target);
    if (from === null) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      clearPreview();
      onSelect(from);
      return;
    }
    const next = monthMove(from, event.key, event.ctrlKey || event.metaKey);
    if (next === null) return;
    event.preventDefault();
    clearPreview();
    focusNext.current = next;
    onSelect(next);
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const date = dateOf(event.target);
    if (date === null) return;
    clearPreview();
    onSelect(date);
  }

  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const date = dateOf(event.target);
    if (date === null || date === previewed.current) return;
    previewed.current = date;
    onPreview(date);
  }

  function onPointerLeave(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    clearPreview();
  }

  return (
    <div className="tw-mg" style={{ display: 'grid', gap: 12, width: '100%' }}>
      <style href="townwise-month-grid" precedence="default">{CSS}</style>
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
                    position: 'relative', minHeight: 44, aspectRatio: '1 / 1', boxSizing: 'border-box', padding: 4,
                    background: C.raised, border: `1px solid ${isSelected ? C.mint : cell.inWeek ? C.line : C.raised}`,
                  }}
                >
                  <span aria-hidden="true" style={{ ...mono, color: cell.isToday ? C.white : C.text2, fontWeight: cell.isToday ? 600 : 400 }}>
                    {String(Number(cell.date.slice(8, 10)))}
                  </span>
                  {cell.event ? <span aria-hidden="true" style={{ ...square, top: 0, right: 0, background: C.white }} /> : null}
                  {cell.note ? <span aria-hidden="true" style={{ ...square, bottom: 0, left: 0, background: C.text2 }} /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <MonthKey />
    </div>
  );
}
