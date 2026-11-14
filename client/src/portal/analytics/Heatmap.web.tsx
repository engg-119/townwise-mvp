import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { theme } from '../../theme';
import { localToday } from '../locations/dates';
import { canFocus, focusBounds, heatmapBlocks, initialFocus, moveFocus, type Cell, type YearBlock } from './cells';
import type { Level } from './levels';
import type { HeatmapProps } from './Heatmap';
import { WEEKDAY_NAMES, WEEK_ORDER } from './words';

// The heatmap on web (home.md 4.4): DOM, not SVG, because each day takes focus. One grid per shown year, newest
// first, 7 weekday rows (Monday first) by 53 week columns of square cells, with month labels above and Mon, Wed
// and Fri at the left. cells.ts decides every cell's state, fill level, marks and label; this file only draws them.
//
// Interactive: each year is role="grid" with its rows and row headers, and the whole heatmap is one tab stop
// (roving tabIndex). The keys of cells.ts moveFocus move focus; Enter or Space selects; Escape clears the
// selection. While a day is selected, moving focus moves the selection with it. A mouse or pen over a cell
// previews it (one delegated handler, touch ignored) and leaving the grid restores the selection. Nothing animates.
// Not interactive (Home, Reading): one picture named by `label`, with no focusable cell. It fits its width rather
// than scrolling sideways, because a keyboard could not scroll a picture with nothing in it to focus. So that its
// month labels never run together on a phone ("JanFebMar"), a narrow picture labels every other month (Jan, Mar,
// May...) and a very narrow one every third (Jan, Apr, Jul, Oct), by a container query on its own width.

const C = theme.color;
const LEVEL_PERCENT = [0, 25, 45, 70, 100] as const;

/** A heat level's fill: the palette's mint at that percent, so it follows the mode (the alpha it was in dark). */
function heat(level: Level): string {
  const percent = LEVEL_PERCENT[level];
  return percent === 100 ? C.mint : `color-mix(in srgb, ${C.mint} ${String(percent)}%, transparent)`;
}
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GAP = 3;
const HEAD = 40;
/**
 * Month starts can be 4 week columns apart, and a label is 3 mono characters, 22px at 12px in Chromium and WebKit.
 * In a picture under the first width, a full 53-week year ((width - HEAD) / 53 a column) leaves under 2px between two
 * labels, so it labels every other month (8 columns apart); under the second, every third (12 columns apart).
 */
const EVERY_OTHER_BELOW = 360;
const EVERY_THIRD_BELOW = 220;

// Hover and selection outlines live in one React-rendered stylesheet, as PortalStyles does (covered by the
// existing style-src 'unsafe-inline'), so hovering re-renders nothing. The keyboard focus ring is the portal's.
const CSS = [
  `.tw-hm [data-sel="1"]{box-shadow:0 0 0 1px ${C.mint},inset 0 0 0 1px ${C.ground}}`,
  `@media (hover:hover){.tw-hm-live [data-date]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
  '.tw-hm-live [data-date]{cursor:pointer}',
  '.tw-hm-fit{container-type:inline-size}',
  `@container (width < ${String(EVERY_OTHER_BELOW)}px){.tw-hm-fit .tw-hm-m2{display:none}}`,
  `@container (width < ${String(EVERY_THIRD_BELOW)}px){.tw-hm-fit .tw-hm-m2{display:inline}.tw-hm-fit .tw-hm-m3{display:none}}`,
].join('\n');

/** The classes that hide a month's label in a narrow picture: off every other month, then off every third. */
function monthClass(month: number): string | undefined {
  const names = [(month - 1) % 2 === 0 ? null : 'tw-hm-m2', (month - 1) % 3 === 0 ? null : 'tw-hm-m3'].filter((name) => name !== null);
  return names.length === 0 ? undefined : names.join(' ');
}

const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap', border: 0,
} as const;

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', color: C.text3, fontVariantNumeric: 'tabular-nums' } as const;

function fillOf(cell: Cell): React.CSSProperties {
  switch (cell.state) {
    case 'value': return { background: heat(cell.level ?? 3) };
    case 'no_data': return { background: C.raised };
    case 'left_out': return { background: C.state };
    case 'closed': return { background: 'transparent', border: `1px solid ${C.line}` };
    case 'pending': return { background: 'transparent', border: `1px dashed ${C.border}` };
    case 'future': return { background: 'transparent' };
  }
}

const square = { position: 'absolute', width: 3, height: 3, pointerEvents: 'none' } as const;

function CellView(props: { cell: Cell; interactive: boolean; active: boolean; selected: boolean }): React.JSX.Element {
  const { cell, interactive } = props;
  const live = interactive && cell.focusable;
  return (
    <div
      {...(interactive ? { role: 'gridcell' } : {})}
      {...(live ? {
        'data-date': cell.date, 'aria-label': cell.label, 'aria-selected': props.selected, tabIndex: props.active ? 0 : -1,
      } : {})}
      {...(props.selected ? { 'data-sel': '1' } : {})}
      style={{ position: 'relative', aspectRatio: '1 / 1', boxSizing: 'border-box', minWidth: 0, ...fillOf(cell) }}
    >
      {cell.eventMark ? <span aria-hidden="true" style={{ ...square, top: 0, right: 0, background: C.white }} /> : null}
      {cell.noteMark ? <span aria-hidden="true" style={{ ...square, bottom: 0, left: 0, background: C.text2 }} /> : null}
    </div>
  );
}

const ROW_HEAD_SHOWN = new Set([0, 2, 4]);

/** One year: memoized, so a key press or a selection re-renders only the blocks it touches. */
const YearGrid = memo(function YearGrid(props: {
  block: YearBlock;
  interactive: boolean;
  /** The roving tab stop, when it is in this year. */
  active: string | null;
  selected: string | null;
}): React.JSX.Element {
  const { block, interactive } = props;
  const columns = `${String(HEAD)}px repeat(${String(block.weeks)}, minmax(0, 1fr))`;
  const row = { display: 'grid', gridTemplateColumns: columns, columnGap: GAP } as const;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div aria-hidden="true" style={{ ...mono, color: C.text2, position: 'sticky', left: 0, justifySelf: 'start' }}>{block.year}</div>
      <div aria-hidden="true" style={{ ...row, ...mono, height: 16 }}>
        {/* Covers the row-header column, as the sticky weekday headers do, so month labels scrolled sideways never
            draw into it. */}
        <span style={{ gridColumnStart: 1, gridRowStart: 1, position: 'sticky', left: 0, zIndex: 1, background: C.ground }} />
        {block.months.map((month) => (
          <span key={month.month} className={monthClass(month.month)} style={{ gridColumnStart: month.col + 2, gridRowStart: 1, whiteSpace: 'nowrap' }}>
            {MONTHS_SHORT[month.month - 1]}
          </span>
        ))}
      </div>
      <div
        {...(interactive ? { role: 'grid', 'aria-label': block.label, 'aria-readonly': true } : {})}
        style={{ display: 'grid', rowGap: GAP }}
      >
        {block.rows.map((cells, index) => (
          <div key={index} {...(interactive ? { role: 'row' } : {})} style={row}>
            <div {...(interactive ? { role: 'rowheader' } : {})} style={{ ...mono, alignSelf: 'stretch', display: 'flex', alignItems: 'center', lineHeight: '10px', fontSize: 10, position: 'sticky', left: 0, zIndex: 1, background: C.ground }}>
              {ROW_HEAD_SHOWN.has(index) ? <span aria-hidden="true">{(WEEKDAY_NAMES[WEEK_ORDER[index] ?? 0] ?? '').slice(0, 3)}</span> : null}
              {interactive ? <span style={SR_ONLY}>{WEEKDAY_NAMES[WEEK_ORDER[index] ?? 0]}</span> : null}
            </div>
            {cells.map((cell, col) => (cell === null
              ? <div key={col} {...(interactive ? { role: 'gridcell' } : {})} />
              : (
                <CellView
                  key={cell.date}
                  cell={cell}
                  interactive={interactive}
                  active={cell.date === props.active}
                  selected={cell.date === props.selected}
                />
              )))}
          </div>
        ))}
      </div>
    </div>
  );
});

function Swatch(props: { style: React.CSSProperties }): React.JSX.Element {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 10, height: 10, boxSizing: 'border-box', ...props.style }} />;
}

function Legend(): React.JSX.Element {
  const item = { display: 'inline-flex', alignItems: 'center', gap: 6 } as const;
  return (
    <div style={{ ...mono, color: C.text2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 16px' }}>
      <span style={item}>
        Fewer
        {([1, 2, 3, 4] as const).map((level) => <Swatch key={level} style={{ background: heat(level) }} />)}
        More
      </span>
      <span style={item}><span style={{ position: 'relative', display: 'inline-block', width: 10, height: 10, background: C.raised }}><span aria-hidden="true" style={{ ...square, top: 0, right: 0, background: C.white }} /></span>Town event or holiday</span>
      <span style={item}><span style={{ position: 'relative', display: 'inline-block', width: 10, height: 10, background: C.raised }}><span aria-hidden="true" style={{ ...square, bottom: 0, left: 0, background: C.text2 }} /></span>Your note</span>
      <span style={item}><Swatch style={{ border: `1px solid ${C.line}` }} />Closed</span>
      <span style={item}><Swatch style={{ background: C.state }} />Left out</span>
      <span style={item}><Swatch style={{ background: C.raised }} />No data</span>
    </div>
  );
}

function dateOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-date]') : null;
  return element?.getAttribute('data-date') ?? null;
}

export function Heatmap(props: HeatmapProps): React.JSX.Element {
  const { days, metric, marks, context, included, years, interactive, pending, onSelect, onPreview } = props;
  const selected = props.selected ?? null;
  const [deviceToday] = useState(localToday);
  const shownToday = props.today ?? deviceToday;
  const blocks = useMemo(
    () => heatmapBlocks({ days, metric, marks, context, included, years, today: shownToday, pending }),
    [days, metric, marks, context, included, years, shownToday, pending],
  );
  const bounds = useMemo(() => focusBounds(days, years, shownToday), [days, years, shownToday]);
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** The day whose cell should take focus after this render: a key moved there, or the panel asked. */
  const focusNext = useRef<string | null>(null);
  const previewed = useRef<string | null>(null);

  const current = bounds === null ? null : active !== null && canFocus(active, bounds) ? active : initialFocus(selected, bounds);

  // A selection made outside the grid (the Day panel's Previous day and Next day) moves the tab stop with it,
  // adjusted while rendering rather than in an effect.
  const [seen, setSeen] = useState(selected);
  if (seen !== selected) {
    setSeen(selected);
    if (selected !== null) setActive(selected);
  }

  const firstFocusKey = useRef(props.focusKey);
  useEffect(() => {
    if (props.focusKey === firstFocusKey.current) return;
    firstFocusKey.current = props.focusKey;
    focusNext.current = selected;
  }, [props.focusKey, selected]);

  useEffect(() => {
    const date = focusNext.current;
    if (date === null || root.current === null) return;
    const cell = root.current.querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (cell === null) return;
    focusNext.current = null;
    cell.focus();
  });

  if (!interactive) {
    return (
      <div role="img" aria-label={props.label} className="tw-hm tw-hm-fit" style={{ display: 'grid', gap: 12 }}>
        <style href="townwise-heatmap" precedence="default">{CSS}</style>
        <div style={{ display: 'grid', gap: 16 }}>
          {blocks.map((block) => <YearGrid key={block.year} block={block} interactive={false} active={null} selected={selected} />)}
        </div>
      </div>
    );
  }

  /** The keys take over from a pointer resting on a cell, so the panel follows focus and the selection. */
  function clearPreview(): void {
    if (previewed.current === null) return;
    previewed.current = null;
    onPreview?.(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    // The focused cell is where the keys start, even if focus got there without a key (a click, the panel).
    const from = dateOf(event.target);
    if (bounds === null || from === null) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      clearPreview();
      setActive(from);
      onSelect?.(from);
      return;
    }
    if (event.key === 'Escape') {
      if (selected === null) return;
      event.preventDefault();
      onSelect?.(null);
      return;
    }
    const next = moveFocus(from, event.key, event.ctrlKey || event.metaKey, bounds);
    if (next === null) return;
    event.preventDefault();
    clearPreview();
    focusNext.current = next;
    setActive(next);
    if (selected !== null && next !== selected) onSelect?.(next);
  }

  function onClick(event: React.MouseEvent<HTMLDivElement>): void {
    const date = dateOf(event.target);
    if (date === null) return;
    setActive(date);
    onSelect?.(date);
  }

  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const date = dateOf(event.target);
    if (date === null || date === previewed.current) return;
    previewed.current = date;
    onPreview?.(date);
  }

  function onPointerLeave(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch' || previewed.current === null) return;
    previewed.current = null;
    onPreview?.(null);
  }

  const yearOf = (date: string | null): string | null => (date === null ? null : date.slice(0, 4));
  return (
    <div className="tw-hm tw-hm-live" style={{ display: 'grid', gap: 12 }}>
      <style href="townwise-heatmap" precedence="default">{CSS}</style>
      <Legend />
      <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
        <div
          ref={root}
          onKeyDown={onKeyDown}
          onClick={onClick}
          onPointerOver={onPointerOver}
          onPointerLeave={onPointerLeave}
          style={{ minWidth: 720, display: 'grid', gap: 16, padding: 3 }}
        >
          {blocks.map((block) => {
            const year = String(block.year);
            return (
              <YearGrid
                key={block.year}
                block={block}
                interactive
                active={yearOf(current) === year ? current : null}
                selected={yearOf(selected) === year ? selected : null}
              />
            );
          })}
        </div>
      </div>
      <p style={{ margin: 0, fontFamily: theme.font.sans, fontSize: 14, lineHeight: '20px', color: C.text2 }}>{props.label}</p>
    </div>
  );
}
