import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { plural } from '../format';
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
// Each row (2026-11-18, owner: “should have more detail”) says only what Townwise keeps: the shown name (with one
// location also the location's own name), the town, its days of sales and notes, whether it is linked, and links to
// its Location settings (org admins) and to the place on Google Maps, a maps URL from the place id with the town as
// the query Google requires (never the name, and no street address, which Townwise doesn't keep).

export const LOCATIONS_MAP_COPY = {
  kicker: 'Locations',
  title: 'Your locations on the map',
  notPlaced: 'Not on the map: not linked to a place on Google Maps.',
  linked: 'Linked to its place on Google Maps.',
  openInMaps: 'Open in Google Maps',
  settings: 'Location settings',
} as const;

/** Google's documented search URL: the place id picks the place, and the query (required) is the town, never a name. */
export function googleMapsUrl(placeId: string, town: { name: string; state: string }): string {
  const query = new URLSearchParams({ api: '1', query: `${town.name}, ${town.state}`, query_place_id: placeId });
  return `https://www.google.com/maps/search/?${query.toString()}`;
}

/** The row's counts, from GET /api/org. */
export function countsLine(location: LocationSummary): string {
  return `${plural(location.coverage.dayCount, 'day', 'days')} of sales · ${plural(location.notesCount, 'note', 'notes')}`;
}

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

  return (
    <Section kicker={LOCATIONS_MAP_COPY.kicker} title={LOCATIONS_MAP_COPY.title}>
      <Stack gap={16}>
        {pinned.length === 0 ? null : (
          <PlaceMap map={map} label={`Map of ${org.org.name}’s locations`} frame={styles.frame} onFailed={setFailedUrl} />
        )}
        <View role="list" style={styles.legend}>
          {pinned.map(({ location, letter }) => (
            <LocationRow key={location.id} org={org} location={location} admin={admin} readOnly={props.readOnly} pin={letters ? letter : null} />
          ))}
          {unpinned.map((location) => (
            <LocationRow key={location.id} org={org} location={location} admin={admin} readOnly={props.readOnly} pin={letters ? '' : null} />
          ))}
        </View>
        {admin && requested !== null && requested > org.locations.length ? <Small>{mentionedLine(requested)}</Small> : null}
      </Stack>
    </Section>
  );
}

/** One row: `pin` is the letter, '' for an empty ring beside a map, or null with no map. */
function LocationRow(props: {
  org: OrgResponse; location: LocationSummary; admin: boolean; readOnly: boolean; pin: string | null;
}): React.JSX.Element {
  const { org, location, admin, readOnly, pin } = props;
  const shown = shownLocationName(location, org);
  const town = `${location.town.name}, ${location.town.state}`;
  const placeId = location.placeId ?? null;
  // With one location the shown name is the organization's, so the location's own name is said once here.
  const where = org.locations.length === 1 && location.name.trim() !== shown.trim() ? `${location.name}, ${town}` : town;
  const disabled = readOnly ? { disabled: true, describedBy: SETTINGS_READ_ONLY_ID } : {};
  return (
    <View role="listitem" style={styles.row}>
      {pin === null ? null : pin === '' ? <View style={[styles.pin, styles.noPin]} /> : <View style={styles.pin}><Mono style={styles.letter}>{pin}</Mono></View>}
      <View style={styles.text}>
        <Body>{shown}</Body>
        <Small>{where}</Small>
        <Small>{countsLine(location)}</Small>
        <Small>{placeId === null ? LOCATIONS_MAP_COPY.notPlaced : LOCATIONS_MAP_COPY.linked}</Small>
        <Actions>
          {admin && placeId === null && org.placeSearch === true ? (
            <LinkButton variant="link" href={locationHref(location.id, 'settings')} label={`Find ${shown} on Google Maps`} {...disabled} />
          ) : admin ? (
            <LinkButton variant="link" href={locationHref(location.id, 'settings')} label={LOCATIONS_MAP_COPY.settings} accessibilityLabel={`${LOCATIONS_MAP_COPY.settings} for ${shown}`} {...disabled} />
          ) : null}
          {placeId === null ? null : <MapsLink url={googleMapsUrl(placeId, location.town)} label={`${LOCATIONS_MAP_COPY.openInMaps}: ${shown}`} />}
        </Actions>
      </View>
    </View>
  );
}

/** A link out to Google Maps: an <a href> in a new tab on web, Linking on native (as SourceChip opens a source). */
function MapsLink(props: { url: string; label: string }): React.JSX.Element {
  const open = Platform.OS === 'web'
    ? { href: props.url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } }
    : { onPress: () => { void Linking.openURL(props.url).catch(() => undefined); } };
  return (
    <Pressable role="link" accessibilityLabel={props.label} {...open} style={styles.mapsLink}>
      <Text style={[theme.type.small, styles.mapsText]}>{LOCATIONS_MAP_COPY.openInMaps}</Text>
    </Pressable>
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
  mapsLink: { minHeight: 44, justifyContent: 'center' },
  mapsText: { color: theme.color.white, textDecorationLine: 'underline' },
});
