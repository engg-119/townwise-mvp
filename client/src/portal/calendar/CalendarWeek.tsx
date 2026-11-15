import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { CARD_MARK, cardWords, headLine, periodCard, weekHead, type InertCell, type MonthBounds, type WeekCard, type WeekDay, type WeekSlot } from './grid';
import { statusWord, type TooltipLines } from './model';

// The Calendar's week view (P28, spec 16.3, step 2): the 7-day block counted from today that holds the selected day,
// which reads its own days when it runs past the grid (grid.ts buildWeek, readRangeFor). On native it is an agenda at
// every width: 7 rows, each a Pressable labeled as its month cell, with its selected state, holding the day's head
// line (the day, a Today tag under today, the status word, the figure with "+70", and the range, "guests" or "No
// forecast") over the day's full-width cards (hours first when timed, the title in full, the kind words; a term or
// season its title and kind words on one run), each on a `panel` fill with a 2px left rule in its mark's token, every
// card's words wrapping.
// Pressing a row selects its day; the selected row is outlined `mint`. An inert day (outside the 25 months) is a
// disabled row with its head line only; a pending one (its reads in flight) shows its head line only. Web has its own
// file (CalendarWeek.web.tsx): day columns from 641px and an agenda below, with the keys and the tooltip. Only types
// are shared with it, since on web './CalendarWeek' is that file itself.

export interface CalendarWeekProps {
  /** The week's 7 days (grid.ts buildWeek). */
  days: readonly WeekSlot[];
  /** The selected day. */
  selected: string;
  /** The block's first day (grid.ts weekStartFor), where Home and End go from (web). */
  weekStart: string;
  /** The 25 months the page shows: a key past them is consumed (web). */
  bounds: MonthBounds;
  /**
   * `moved`: a key moved the selection (web), so the page leaves the scroll where it is. `month`: the month the grid
   * then shows, after PageUp or PageDown; null otherwise.
   */
  onSelect: (date: string, moved?: boolean, month?: string | null) => void;
  /** Dimmed and aria-busy while the reads of the shown range (grid.ts readRangeFor) load again. */
  busy: boolean;
  /** “Nov 15 to 21, 2026”: the week's name. */
  label: string;
  /** Web only: the hover tooltip's lines for a day; null for none. */
  tooltip: (date: string) => TooltipLines | null;
}

function Card(props: { card: WeekCard }): React.JSX.Element {
  const { card } = props;
  const rule = { borderLeftColor: c[CARD_MARK[card.kind]] };
  if (periodCard(card)) {
    return (
      <View style={[styles.card, rule]}>
        <Text style={styles.period}>{card.title} <Text style={styles.sub}>{card.sub}</Text></Text>
      </View>
    );
  }
  return (
    <View style={[styles.card, rule]}>
      {card.hours === null ? null : <Text style={styles.hours}>{card.hours}</Text>}
      <Text style={styles.title}>{card.title}</Text>
      <Text style={styles.sub}>{card.sub}</Text>
    </View>
  );
}

function Head(props: { day: WeekDay }): React.JSX.Element {
  const { day } = props;
  const status = statusWord(day.status);
  const last = headLine(day);
  return (
    <View style={styles.head}>
      <Text style={[styles.day, day.isToday ? styles.today : null]}>{weekHead(day.date)}</Text>
      {day.isToday ? <Text style={styles.tag}>Today</Text> : null}
      {day.pending || status === null ? null : <Text style={styles.status}>{status}</Text>}
      {day.pending || day.figure === null ? null : (
        <Text style={[styles.figure, day.figure.kind === 'actual' ? styles.past : null]}>{String(day.figure.value)}</Text>
      )}
      {day.pending || day.noteGuests === 0 ? null : <Text style={styles.added}>{`+${String(day.noteGuests)}`}</Text>}
      {day.pending || last === null ? null : <Text style={styles.line}>{last}</Text>}
    </View>
  );
}

function Row(props: { day: WeekDay; selected: boolean; onSelect: (date: string) => void }): React.JSX.Element {
  const { day } = props;
  // One accessible element, so the cards inside it are heard through its hint (none on a day without cards).
  const hint = cardWords(day.cards);
  return (
    <Pressable
      role="button"
      accessibilityLabel={day.label}
      {...(hint === null ? {} : { accessibilityHint: hint })}
      accessibilityState={{ selected: props.selected }}
      onPress={() => { props.onSelect(day.date); }}
      style={[styles.row, props.selected ? styles.selected : null]}
    >
      <Head day={day} />
      {day.pending ? null : day.cards.map((card) => <Card key={card.key} card={card} />)}
    </Pressable>
  );
}

function InertRow(props: { day: InertCell }): React.JSX.Element {
  return (
    <Pressable
      role="button"
      disabled
      accessibilityLabel={props.day.label}
      accessibilityState={{ disabled: true }}
      style={[styles.row, styles.inert]}
    >
      <Text style={[styles.day, styles.muted]}>{weekHead(props.day.date)}</Text>
    </Pressable>
  );
}

export function CalendarWeek(props: CalendarWeekProps): React.JSX.Element {
  return (
    <View accessibilityLabel={props.label} accessibilityState={{ busy: props.busy }} style={[styles.week, props.busy ? styles.busy : null]}>
      {props.days.map((day) => (day.kind === 'inert'
        ? <InertRow key={day.date} day={day} />
        : <Row key={day.date} day={day} selected={day.date === props.selected} onSelect={props.onSelect} />))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  week: { gap: 3, width: '100%' },
  busy: { opacity: 0.6 },
  row: { gap: 6, padding: 8, backgroundColor: c.raised, borderWidth: 1, borderColor: c.raised },
  selected: { borderColor: c.mint },
  inert: { backgroundColor: 'transparent', borderColor: c.border },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2 },
  day: { ...theme.type.mono, color: c.text2, fontVariant: ['tabular-nums'] },
  today: { color: c.white, fontWeight: '600' },
  muted: { color: c.text3 },
  tag: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.white, borderWidth: 1, borderColor: c.line, paddingHorizontal: 4 },
  status: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2, textTransform: 'uppercase' },
  figure: { ...theme.type.monoValue, fontSize: 22, lineHeight: 26, color: c.white, fontVariant: ['tabular-nums'] },
  past: { color: c.text2 },
  added: { ...theme.type.mono, color: c.mint, fontVariant: ['tabular-nums'] },
  line: { ...theme.type.mono, fontSize: 11, lineHeight: 14, color: c.text3 },
  card: { gap: 2, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: c.panel, borderLeftWidth: 2 },
  hours: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2 },
  title: { ...theme.type.small, fontSize: 12, lineHeight: 16, color: c.white },
  period: { ...theme.type.small, fontSize: 12, lineHeight: 16, color: c.text2 },
  sub: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3 },
});
