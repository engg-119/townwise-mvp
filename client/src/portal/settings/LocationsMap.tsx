import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { usePortal } from '../PortalProvider';
import { PlaceMap } from '../places/PlaceMap';
import { usePlacesMap } from '../places/usePlacesMap';
import { shownLocationName } from '../locations/naming';
import { locationHref } from '../routing';
import type { LocationSummary, OrgResponse } from '../schemas';
import { Actions, LinkButton } from '../ui/Button';
import { SETTINGS_READ_ONLY_ID } from './copy';
import { Section, Stack } from '../ui/layout';
import { Body, Mono, Small } from '../ui/text';
import { theme } from '../../theme';

// D47, on Settings (P18): one map of every location of the organization that has a Google place, each pin lettered
// A, B, C in the order GET /api/org lists the locations (POST /api/places/map with `labeled: true`), and a legend
// under it naming each letter's location and town. The letters show only beside a map: with the map off (no static
// key or signing secret) the legend is a plain list. A location without a place is listed after them as not on the
// map, and an org admin gets the way to link it from its Location settings while the Places search is on. For org
// admins, while the request named more locations than exist, the P9 line asking for the others shows here too: with
// one location, Locations opens that location's Home, so P9 never shows it then.

export const LOCATIONS_MAP_COPY = {
  kicker: 'Locations',
  title: 'Your locations on the map',
  notPlaced: 'Not on the map: not linked to a place on Google Maps.',
} as const;

export function mentionedLine(requested: number): string {
  return `Your request mentioned ${requested.toLocaleString('en-US')} locations. Add the others when you’re ready.`;
}

/**
 * The locations with a place, in the organization's order, each with its pin's letter: one letter per distinct place,
 * so two locations on the same place share a pin and its letter (the map route refuses a repeated id). `placeIds` is
 * what the map is asked for, in letter order.
 */
export function lettered(locations: readonly LocationSummary[]): {
  rows: { location: LocationSummary; letter: string }[]; placeIds: string[];
} {
  const letters = new Map<string, string>();
  const rows: { location: LocationSummary; letter: string }[] = [];
  for (const location of locations) {
    const id = location.placeId;
    if (id == null) continue;
    if (!letters.has(id)) {
      if (letters.size === 26) continue;
      letters.set(id, String.fromCharCode(65 + letters.size));
    }
    rows.push({ location, letter: letters.get(id) ?? '' });
  }
  return { rows, placeIds: [...letters.keys()] };
}

export function LocationsMap(props: { org: OrgResponse; admin: boolean; readOnly: boolean }): React.JSX.Element | null {
  const { org, admin } = props;
  const { api } = usePortal();
  const { rows: pinned, placeIds } = lettered(org.locations);
  const map = usePlacesMap(api, placeIds, { labeled: true });
  /** The map image that failed to load, if any: its letters would point at nothing. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (org.locations.length === 0) return null;
  const pinnedIds = new Set(pinned.map((entry) => entry.location.id));
  const unpinned = org.locations.filter((location) => !pinnedIds.has(location.id));
  const requested = org.requestedLocationCount;
  const letters = map !== null && map.url !== failedUrl;
  const name = (location: LocationSummary): string => shownLocationName(location, org);

  return (
    <Section kicker={LOCATIONS_MAP_COPY.kicker} title={LOCATIONS_MAP_COPY.title}>
      <Stack gap={16}>
        {pinned.length === 0 ? null : (
          <PlaceMap map={map} label={`Map of ${org.org.name}’s locations`} frame={styles.frame} onFailed={setFailedUrl} />
        )}
        <View role="list" style={styles.legend}>
          {pinned.map(({ location, letter }) => (
            <View key={location.id} role="listitem" style={styles.row}>
              {letters ? <View style={styles.pin}><Mono style={styles.letter}>{letter}</Mono></View> : null}
              <View style={styles.text}>
                <Body>{name(location)}</Body>
                <Small>{`${location.town.name}, ${location.town.state}`}</Small>
              </View>
            </View>
          ))}
          {unpinned.map((location) => (
            <View key={location.id} role="listitem" style={styles.row}>
              {letters ? <View style={[styles.pin, styles.noPin]} /> : null}
              <View style={styles.text}>
                <Body>{name(location)}</Body>
                <Small>{`${location.town.name}, ${location.town.state}. ${LOCATIONS_MAP_COPY.notPlaced}`}</Small>
                {admin && org.placeSearch === true ? (
                  <Actions>
                    <LinkButton
                      variant="link"
                      href={locationHref(location.id, 'settings')}
                      label={`Find ${name(location)} on Google Maps`}
                      {...(props.readOnly ? { disabled: true, describedBy: SETTINGS_READ_ONLY_ID } : {})}
                    />
                  </Actions>
                ) : null}
              </View>
            </View>
          ))}
        </View>
        {admin && requested !== null && requested > org.locations.length ? <Small>{mentionedLine(requested)}</Small> : null}
      </Stack>
    </Section>
  );
}

const PIN = 24;

const styles = StyleSheet.create({
  frame: { width: '100%', maxWidth: 640 },
  legend: { maxWidth: 640, gap: theme.space[3] },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space[3] },
  pin: {
    width: PIN, height: PIN, borderRadius: PIN / 2, marginTop: 2,
    backgroundColor: theme.color.mint, alignItems: 'center', justifyContent: 'center',
  },
  noPin: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.color.line },
  letter: { color: theme.color.onMint, fontWeight: 600 },
  text: { flex: 1, gap: 2 },
});
