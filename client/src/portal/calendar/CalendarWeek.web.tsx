import { useEffect, useId, useRef, useState } from 'react';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import type { CalendarWeekProps } from './CalendarWeek';
import { anchorOf, DayTooltip, type TooltipAnchor } from './DayTooltip.web';
import { CARD_MARK, CELL_GAP, gridHeight, gridMove, headLine, periodCard, weekHead, type InertCell, type WeekCard, type WeekDay, type WeekSlot } from './grid';
import { statusWord } from './model';

// The Calendar's week view on web (P28, spec 16.3, step 2): DOM, as the month grid is, because each day takes focus.
// From 641px a role="grid" named by the week label with one row of 7 day columns, each a full-height gridcell, the
// click target and the roving tab stop, labeled as its month cell (so both views say the same) and described by its
// card list, which holds the hours, terms and rules the label leaves out. A column's head: the day ("Mon 16", "Tue Dec
// 1" on a month's 1st, a Today tag under today), the status word, the figure with "+70", and one line (the range,
// "guests" under a past figure, "No forecast"). Then every item on the day as a card (grid.ts buildWeek), not
// focusable; the panel keeps the actions. The box is at least as tall as the month grid at the same width, so
// switching views keeps the page height. Keys are the month grid's (grid.ts gridMove, layout 'week'), and the moved-to
// column takes focus without scrolling. A mouse or pen over a column head shows the day's tooltip; cards and touch
// show none. An inert day (outside the 25 months) is its head line only, with no data-date; a pending day (its
// reads in flight) is its head line only, still the tab stop when selected, with no description and no tooltip.
// At 640px and below the week is an agenda: the same grid with 7 rows of one gridcell each, every day's head on one
// line above its full-width cards, so Up and Down move a day, as a screen reader hears the next row; its height
// follows what it holds.

const C = theme.color;

const CSS = [
  '.tw-cw [data-date]{cursor:pointer}',
  `@media (hover:hover){.tw-cw [data-date]:hover:not([data-sel="1"]){box-shadow:0 0 0 1px ${C.white}}}`,
].join('\n');

const mono = { fontFamily: theme.font.mono, fontSize: 12, lineHeight: '16px', fontVariantNumeric: 'tabular-nums' } as const;
const small = { fontFamily: theme.font.mono, fontSize: 10, lineHeight: '14px' } as const;
const sans = { fontFamily: theme.font.sans, fontSize: 12, lineHeight: '16px' } as const;

/** How long a pointer may rest over no head before the tooltip clears, as the month grid's. */
const CLEAR_DELAY_MS = 80;

function dateOf(target: EventTarget | null): string | null {
  const element = target instanceof Element ? target.closest('[data-date]') : null;
  return element?.getAttribute('data-date') ?? null;
}

/**
 * One card: its hours first when timed (mono 10), the title in full (sans 12/16), then its kind words (mono 10,
 * `text3`), on a `panel` fill with a 2px left rule in its mark's token. A term or season keeps its title and kind
 * words on one run, which wraps as every card's words do, so nothing is cut. The spaces between the parts aren't
 * drawn (the card is a grid) but keep the words apart in the column's description.
 */
function Card(props: { card: WeekCard }): React.JSX.Element {
  const { card } = props;
  const frame = { display: 'grid', gap: 2, minWidth: 0, padding: '4px 6px', backgroundColor: C.panel, borderLeft: `2px solid ${C[CARD_MARK[card.kind]]}` } as const;
  if (periodCard(card)) {
    return (
      <div role="listitem" style={frame}>
        <span style={{ ...sans, color: C.text2, overflowWrap: 'anywhere' }}>{card.title}{' '}<span style={{ ...small, color: C.text3 }}>{card.sub}</span></span>
      </div>
    );
  }
  return (
    <div role="listitem" style={frame}>
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
              <span style={{ ...mono, fontSize: 22, lineHeight: '26px', fontWeight: 500, color: day.figure.kind === 'actual' ? C.text2 : C.white }}>{String(day.figure.value)}</span>
              {day.noteGuests > 0 ? <span style={{ ...mono, color: C.mint }}>{`+${String(day.noteGuests)}`}</span> : null}
            </span>
          )}
          {last === null ? null : <span style={{ ...mono, fontSize: 11, lineHeight: '14px', color: C.text3 }}>{last}</span>}
        </>
      )}
    </div>
  );
}

/** A day's column (an agenda row's one cell): its head, then its card list, which describes it. */
function Column(props: { day: WeekDay; selected: boolean; listId: string; agenda: boolean }): React.JSX.Element {
  const { day } = props;
  const described = !day.pending && day.cards.length > 0;
  return (
    <div
      role="gridcell"
      data-date={day.date}
      {...(props.selected ? { 'data-sel': '1' } : {})}
      aria-label={day.label}
      aria-selected={props.selected}
      {...(described ? { 'aria-describedby': props.listId } : {})}
      tabIndex={props.selected ? 0 : -1}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, boxSizing: 'border-box', padding: 6,
        backgroundColor: C.raised, borderWidth: 1, borderStyle: 'solid', borderColor: props.selected ? C.mint : C.raised,
      }}
    >
      <Head day={day} agenda={props.agenda} />
      {described ? (
        <div role="list" id={props.listId} style={{ display: 'grid', gap: 4, alignContent: 'start', minWidth: 0 }}>
          {day.cards.map((card, at) => [at > 0 ? ' ' : null, <Card key={card.key} card={card} />])}
        </div>
      ) : null}
    </div>
  );
}

function InertColumn(props: { day: InertCell }): React.JSX.Element {
  return (
    <div
      role="gridcell"
      aria-disabled="true"
      aria-label={props.day.label}
      style={{ minWidth: 0, boxSizing: 'border-box', padding: 6, borderWidth: 1, borderStyle: 'solid', borderColor: C.border }}
    >
      <span aria-hidden="true"><DayName date={props.day.date} today={false} inert /></span>
    </div>
  );
}

export function CalendarWeek(props: CalendarWeekProps): React.JSX.Element {
  const { days, selected, onSelect, tooltip } = props;
  const { width, phone } = useBreakpoint();
  // At 640px and below each day is a row, so Up and Down move a day there.
  const layout = phone ? 'agenda' : 'week';
  const ids = useId().replace(/:/g, '');
  const box = useRef<HTMLDivElement>(null);
  /** The day whose column takes focus after this render: a key moved there. */
  const focusNext = useRef<string | null>(null);
  const [tip, setTip] = useState<{ date: string; anchor: TooltipAnchor } | null>(null);
  /** Cancels the clear waiting to run, if any. */
  const pending = useRef<(() => void) | null>(null);
  const lines = tip === null ? null : tooltip(tip.date);

  useEffect(() => {
    const date = focusNext.current;
    if (date === null || box.current === null) return;
    const cell = box.current.querySelector<HTMLElement>(`[data-date="${date}"]`);
    if (cell === null) return;
    focusNext.current = null;
    cell.focus({ preventScroll: true });
  });

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
    const next = gridMove(from, event.key, event.ctrlKey || event.metaKey, { layout, weekStart: props.weekStart, bounds: props.bounds });
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

  // Over a column's head only: a card, a gap or a pending or inert day clears the tooltip.
  function onPointerOver(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    const head = event.target instanceof Element ? event.target.closest('[data-head]') : null;
    const date = head === null ? null : dateOf(head);
    if (head === null || date === null) { clearSoon(); return; }
    cancelClear();
    if (date === tip?.date || box.current === null) return;
    setTip({ date, anchor: anchorOf(head, box.current) });
  }

  function onPointerLeave(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === 'touch') return;
    cancelClear();
    setTip(null);
  }

  const dayOf = (day: WeekSlot): React.JSX.Element => (day.kind === 'inert'
    ? <InertColumn key={day.date} day={day} />
    : <Column key={day.date} day={day} selected={day.date === selected} listId={`${ids}-cards-${day.date}`} agenda={phone} />);

  return (
    <div ref={box} className="tw-cw" style={{ position: 'relative', width: '100%', opacity: props.busy ? 0.6 : 1 }}>
      <style href="townwise-calendar-week" precedence="default">{CSS}</style>
      <div
        role="grid"
        aria-label={props.label}
        aria-readonly
        aria-busy={props.busy}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onPointerOver={onPointerOver}
        onPointerLeave={onPointerLeave}
        style={phone ? { display: 'grid', gap: CELL_GAP } : { display: 'grid', minHeight: gridHeight(width) }}
      >
        {phone ? days.map((day) => <div key={day.date} role="row" style={{ display: 'grid' }}>{dayOf(day)}</div>) : (
          <div role="row" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: CELL_GAP }}>{days.map(dayOf)}</div>
        )}
      </div>
      {tip === null || lines === null ? null : <DayTooltip tip={lines} anchor={tip.anchor} />}
    </div>
  );
}
