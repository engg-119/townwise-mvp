import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import type { Town } from '../schemas';
import { townLabel, type FoundPlace } from '../onboarding/places';
import { webAria } from '../ui/aria';
import { LoadingLine } from '../ui/feedback';
import { Small } from '../ui/text';
import { SCRIPT_FOCUS, useFocusOnMount } from './focus';
import { PlaceMap } from './PlaceMap';

// "Here's what we found" (the onboarding proposal's Step 1, the Home2-Confirm board): Google's map of the place, then
// the name from the pick, Google's address and the town Townwise matched, with where it came from. It takes focus when
// it appears, since the search it replaces had it. PlaceSummary is the same facts in one block, for the form a
// confirmed place fills in; it takes focus when the page asks, since the card it replaces had it. PlaceRow is one
// checked place in the places checklist, under the field that keeps focus. Nothing animates.

/** What the card says about the town: one of the twelve, another town, or none Townwise can use. */
export function townLine(town: Town | null): string {
  if (town === null) return 'Townwise works with businesses in a US town, and Google Maps puts this place in none.';
  if (town.townId !== null) return `${townLabel(town)}, one of the twelve towns Townwise has researched.`;
  return `${townLabel(town)}. Townwise hasn’t researched this town yet, so you’ll see your own data without a town profile.`;
}

export const GOOGLE_SOURCE = 'From Google Maps. Townwise keeps Google’s id for the place and its town, not the address or the map.';

/** Under the checked places (P3, P10): a request keeps each one's Google name too. P16 keeps none: GOOGLE_SOURCE. */
export const PLACES_SOURCE = 'From Google Maps. Townwise keeps Google’s id for each place, its name and its town, not the address or the map.';

type Host = React.ComponentRef<typeof Text>;

export function PlaceCard(props: { place: FoundPlace; note?: string | null; children?: React.ReactNode }): React.JSX.Element {
  const { place } = props;
  const { phone } = useBreakpoint();
  const heading = useFocusOnMount<Host>();
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

/**
 * The confirmed place in a form: what it is, where it came from, and a way to change it. `focusOnMount` moves focus
 * to it when it appears (P10, after Looks right).
 */
export function PlaceSummary(props: { place: FoundPlace; focusOnMount?: boolean; children?: React.ReactNode }): React.JSX.Element {
  const { place } = props;
  const kicker = useFocusOnMount<Host>(props.focusOnMount === true);
  return (
    <View style={[styles.card, styles.summary]} role="group" aria-label="Your place on Google Maps">
      <Text ref={kicker} {...SCRIPT_FOCUS} style={styles.kicker}>On Google Maps</Text>
      <Text style={styles.name}>{place.name}</Text>
      <Text style={styles.fact}>{place.address}</Text>
      <Text style={styles.fact}>{townLine(place.town)}</Text>
      <Small>{GOOGLE_SOURCE}</Small>
      {props.children}
    </View>
  );
}

/**
 * One row of the places checklist, a group named by `label`: while `place` is null, a line saying it is loading
 * (“Getting {label} from Google Maps…” unless `loadingText` says otherwise); then Google's map, 160 wide beside the
 * facts or above them on a phone, the name, the address and the town line. `children` follow (the row's Remove, and
 * what the page adds). It takes no focus: the search field keeps it.
 */
export function PlaceRow(props: { label: string; place: FoundPlace | null; loadingText?: string; children?: React.ReactNode }): React.JSX.Element {
  const { place } = props;
  const map = place?.map ?? null;
  const { phone } = useBreakpoint();
  return (
    <View role="group" aria-label={props.label} style={[styles.card, styles.row, phone ? styles.rowPhone : null]}>
      {place === null || map === null ? null : (
        <View style={phone ? styles.rowMapPhone : styles.rowMap}>
          <PlaceMap map={map} label={`Map of the area around ${place.name}`} />
        </View>
      )}
      <View style={styles.rowBody}>
        {place === null ? <LoadingLine text={props.loadingText ?? `Getting ${props.label} from Google Maps…`} minHeight={44} /> : (
          <>
            <Text style={styles.name}>{place.name}</Text>
            <Text style={styles.fact}>{place.address}</Text>
            <Text style={styles.fact}>{townLine(place.town)}</Text>
          </>
        )}
        {props.children}
      </View>
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
  row: { flexDirection: 'row', padding: theme.space[4], gap: theme.space[4] },
  rowPhone: { flexDirection: 'column' },
  rowMap: { width: 160 },
  rowMapPhone: { width: '100%' },
  rowBody: { flexGrow: 1, flexShrink: 1, gap: theme.space[1] },
});
