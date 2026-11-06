import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import type { Town } from '../schemas';
import { townLabel, type FoundPlace } from '../onboarding/places';
import { webAria } from '../ui/aria';
import { Small } from '../ui/text';
import { PlaceMap } from './PlaceMap';

// "Here's what we found" (the onboarding proposal's Step 1, the Home2-Confirm board): Google's map of the place, then
// the name from the pick, Google's address and the town Townwise matched, with where it came from. It takes focus when
// it appears, since the search it replaces had it. PlaceSummary is the same facts in one block, for the form a
// confirmed place fills in. Nothing animates.

/** What the card says about the town: one of the twelve, another town, or none Townwise can use. */
export function townLine(town: Town | null): string {
  if (town === null) return 'Townwise works with businesses in a US town, and Google Maps puts this place in none.';
  if (town.townId !== null) return `${townLabel(town)}, one of the twelve towns Townwise has researched.`;
  return `${townLabel(town)}. Townwise hasn’t researched this town yet, so you’ll see your own data without a town profile.`;
}

export const GOOGLE_SOURCE = 'From Google Maps. Townwise keeps only Google’s id for the place.';

type Host = React.ComponentRef<typeof Text>;

/** On web the heading takes focus from script only (tabIndex -1 keeps it out of the tab order). */
const SCRIPT_FOCUS: object = Platform.OS === 'web' ? { tabIndex: -1 } : {};

/** Moves focus (web) or the screen reader (native) to the card's heading once, when it mounts. */
function useFocusOnMount(): React.RefObject<Host | null> {
  const ref = useRef<Host>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (Platform.OS === 'web') {
      (node as unknown as { focus?: () => void }).focus?.();
      return;
    }
    AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
  }, []);
  return ref;
}

export function PlaceCard(props: { place: FoundPlace; note?: string | null; children?: React.ReactNode }): React.JSX.Element {
  const { place } = props;
  const { phone } = useBreakpoint();
  const heading = useFocusOnMount();
  return (
    <View style={styles.card}>
      <PlaceMap map={place.map} label={`Map of the area around ${place.name}`} />
      <View style={[styles.body, { padding: phone ? theme.space[4] : theme.space[5] }]}>
        <Text ref={heading} role="heading" {...webAria({ 'aria-level': 3 })} {...SCRIPT_FOCUS} style={styles.kicker}>
          Here’s what we found
        </Text>
        <Text style={[phone ? theme.type.h3Phone : theme.type.h3, styles.white]}>{place.name}</Text>
        <View style={styles.facts}>
          <Text style={styles.fact}>{place.address}</Text>
          <Text style={styles.fact}>{townLine(place.town)}</Text>
          {props.note === undefined || props.note === null ? null : <Text style={styles.fact}>{props.note}</Text>}
        </View>
        <Small>{GOOGLE_SOURCE}</Small>
        {props.children}
      </View>
    </View>
  );
}

/** The confirmed place in a form: what it is, where it came from, and a way to change it. */
export function PlaceSummary(props: { place: FoundPlace; children?: React.ReactNode }): React.JSX.Element {
  const { place } = props;
  return (
    <View style={[styles.card, styles.summary]} role="group" aria-label="Your place on Google Maps">
      <Text style={styles.kicker}>On Google Maps</Text>
      <Text style={styles.name}>{place.name}</Text>
      <Text style={styles.fact}>{place.address}</Text>
      <Text style={styles.fact}>{townLine(place.town)}</Text>
      <Small>{GOOGLE_SOURCE}</Small>
      {props.children}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  card: { backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: theme.radius.none, maxWidth: 640 },
  body: { gap: theme.space[3] },
  summary: { padding: theme.space[4], gap: theme.space[2] },
  kicker: { ...theme.type.label, color: c.text3 },
  white: { color: c.white },
  name: { ...theme.type.sub, fontWeight: 600, color: c.white },
  facts: { gap: theme.space[1] },
  fact: { ...theme.type.sub, color: c.text2 },
});
