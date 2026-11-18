import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { CARD_MARK, periodCard, type WeekCard } from './grid';

// One agenda card (P28's week view on native and in its web agenda, and the calendar agenda of Your data, D49): hours
// first when timed, the title in full, the kind words; a term or season its title and kind words on one run. A `panel`
// fill with a 2px left rule in its mark's token, every card's words wrapping. `children` follow the kind words (the
// calendar agenda's "Note made").

export function AgendaCard(props: { card: Pick<WeekCard, 'kind' | 'hours' | 'title' | 'sub'>; children?: React.ReactNode }): React.JSX.Element {
  const { card } = props;
  const rule = { borderLeftColor: c[CARD_MARK[card.kind]] };
  if (periodCard(card)) {
    return (
      <View style={[styles.card, rule]}>
        <Text style={styles.period}>{card.title} <Text style={styles.sub}>{card.sub}</Text></Text>
        {props.children}
      </View>
    );
  }
  return (
    <View style={[styles.card, rule]}>
      {card.hours === null ? null : <Text style={styles.hours}>{card.hours}</Text>}
      <Text style={styles.title}>{card.title}</Text>
      <Text style={styles.sub}>{card.sub}</Text>
      {props.children}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  card: { gap: 2, paddingVertical: 4, paddingHorizontal: 6, backgroundColor: c.panel, borderLeftWidth: 2 },
  hours: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text2 },
  title: { ...theme.type.small, fontSize: 12, lineHeight: 16, color: c.white },
  period: { ...theme.type.small, fontSize: 12, lineHeight: 16, color: c.text2 },
  sub: { ...theme.type.mono, fontSize: 10, lineHeight: 14, color: c.text3 },
});
