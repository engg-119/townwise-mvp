import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { plural } from '../format';
import { webAria } from '../ui/aria';
import { usePortal } from '../PortalProvider';
import { PlaceMap } from '../places/PlaceMap';
import { useLocationsMap, type LocationsMapAnswer } from '../places/useLocationsMap';
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
// Hover (2026-11-18, owner: “there should be a hover effect on the map”): the map comes from GET /api/org/locations/map,
// which sets the view itself and answers where each pin sits, so a transparent target sits over each pin once the
// image has loaded. Hovering, focusing or pressing a pin rings it, names it in a label above it and lights its rows;
// hovering or pressing a row, or focusing its Google Maps link, does the same for its pin. Pins are buttons in the tab
// order, so the keyboard reaches them. Nothing moves the layout: the targets, ring and label sit over the image. With
// no image (the map off, Google refusing it, a failed load) or no pins in the answer, there are no targets.

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
  const answer = useLocationsMap(api, placeIds.join(','));
  const { map } = answer;
  /** The map image that failed to load, and the one that loaded: targets and letters only beside a loaded image. */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  /** The place whose pin and rows are lit. */
  const [active, setActive] = useState<string | null>(null);
  if (org.locations.length === 0) return null;
  const pinnedIds = new Set(pinned.map((entry) => entry.location.id));
  const unpinned = org.locations.filter((location) => !pinnedIds.has(location.id));
  const requested = org.requestedLocationCount;
  const letters = map !== null && map.url !== failedUrl;
  const targets = letters && map.url === loadedUrl ? answer.pins : [];
  const hover = { active, setActive };

  return (
    <Section kicker={LOCATIONS_MAP_COPY.kicker} title={LOCATIONS_MAP_COPY.title}>
      <Stack gap={16}>
        {pinned.length === 0 ? null : (
          <View style={styles.frame}>
            <PlaceMap map={map} label={`Map of ${org.org.name}’s locations`} onFailed={setFailedUrl} onLoaded={setLoadedUrl} />
            {targets.length === 0 ? null : (
              <PinTargets pins={targets} names={namesByPlace(pinned, org)} hover={hover} />
            )}
          </View>
        )}
        <View role="list" style={styles.legend}>
          {pinned.map(({ location, letter }) => (
            <LocationRow key={location.id} org={org} location={location} admin={admin} readOnly={props.readOnly} pin={letters ? letter : null} hover={targets.length === 0 ? null : hover} />
          ))}
          {unpinned.map((location) => (
            <LocationRow key={location.id} org={org} location={location} admin={admin} readOnly={props.readOnly} pin={letters ? '' : null} hover={null} />
          ))}
        </View>
        {admin && requested !== null && requested > org.locations.length ? <Small>{mentionedLine(requested)}</Small> : null}
      </Stack>
    </Section>
  );
}

interface Hover { active: string | null; setActive: (placeId: string | null) => void }

/** Each place's shown names, joined: two locations on one place share its pin. */
function namesByPlace(pinned: readonly { location: LocationSummary }[], org: OrgResponse): Map<string, string> {
  const names = new Map<string, string[]>();
  for (const { location } of pinned) {
    if (location.placeId == null) continue;
    names.set(location.placeId, [...(names.get(location.placeId) ?? []), shownLocationName(location, org)]);
  }
  return new Map([...names].map(([id, list]) => [id, list.join(', ')]));
}

/**
 * A press: on web the pointer has already lit it by hovering (and a tap by focusing), so a press keeps it lit; on
 * native, where there is no hover, a press toggles it.
 */
function pressed(lit: boolean, placeId: string): string | null {
  return Platform.OS === 'web' || !lit ? placeId : null;
}

/** Where a pin's label goes: below the pin near the top of the map, and kept inside the frame near its sides. */
function labelPlace(pin: { x: number; y: number }): object {
  const vertical = pin.y < 0.4 ? styles.labelBelow : styles.labelAbove;
  const horizontal = pin.x < 0.25 ? styles.labelLeft : pin.x > 0.75 ? styles.labelRight : styles.labelCenter;
  return [vertical, horizontal];
}

/** The transparent targets over the image's pins, the ring on the lit one, and its name above it. */
function PinTargets(props: { pins: LocationsMapAnswer['pins']; names: Map<string, string>; hover: Hover }): React.JSX.Element {
  const { pins, names, hover } = props;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {pins.map((pin) => {
        const lit = hover.active === pin.placeId;
        const name = names.get(pin.placeId) ?? pin.letter;
        return (
          <View key={pin.placeId} style={[styles.anchor, { left: `${String(pin.x * 100)}%`, top: `${String(pin.y * 100)}%` }]} pointerEvents="box-none">
            {lit ? (
              <View style={[styles.label, labelPlace(pin)]} pointerEvents="none">
                <Text style={styles.labelText} numberOfLines={1}>{name}</Text>
              </View>
            ) : null}
            <Pressable
              role="button"
              accessibilityLabel={`${pin.letter}: ${name}`}
              {...(Platform.OS === 'web' ? webAria({ 'aria-pressed': lit }) : { accessibilityState: { selected: lit } })}
              onHoverIn={() => { hover.setActive(pin.placeId); }}
              onHoverOut={() => { hover.setActive(null); }}
              onFocus={() => { hover.setActive(pin.placeId); }}
              onBlur={() => { hover.setActive(null); }}
              onPress={() => { hover.setActive(pressed(lit, pin.placeId)); }}
              style={[styles.target, lit ? styles.targetLit : null]}
            />
          </View>
        );
      })}
    </View>
  );
}

/** One row: `pin` is the letter, '' for an empty ring beside a map, or null with no map. */
function LocationRow(props: {
  org: OrgResponse; location: LocationSummary; admin: boolean; readOnly: boolean; pin: string | null; hover: Hover | null;
}): React.JSX.Element {
  const { org, location, admin, readOnly, pin, hover } = props;
  const shown = shownLocationName(location, org);
  const town = `${location.town.name}, ${location.town.state}`;
  const placeId = location.placeId ?? null;
  // With one location the shown name is the organization's, so the location's own name is said once here.
  const where = org.locations.length === 1 && location.name.trim().toLowerCase() !== shown.trim().toLowerCase() ? `${location.name}, ${town}` : town;
  const disabled = readOnly ? { disabled: true, describedBy: SETTINGS_READ_ONLY_ID } : {};
  const lit = hover !== null && placeId !== null && hover.active === placeId;
  const light = hover === null || placeId === null ? null : (on: boolean): void => { hover.setActive(on ? placeId : null); };
  const body = (
    <>
      {pin === null ? null : pin === '' ? <View style={[styles.pin, styles.noPin]} /> : <View style={[styles.pin, lit ? styles.pinLit : null]}><Mono style={styles.letter}>{pin}</Mono></View>}
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
          {placeId === null ? null : <MapsLink url={googleMapsUrl(placeId, location.town)} label={`${LOCATIONS_MAP_COPY.openInMaps}: ${shown}`} {...(light === null ? {} : { onLight: light })} />}
        </Actions>
      </View>
    </>
  );
  if (light === null) return <View role="listitem" style={styles.row}>{body}</View>;
  // The row itself takes no focus (its links do); a pointer over it, or a press on it, lights its pin.
  return (
    <Pressable
      role="listitem"
      accessible={false}
      focusable={false}
      onHoverIn={() => { light(true); }}
      onHoverOut={() => { light(false); }}
      onPress={() => { light(pressed(lit, placeId ?? '') !== null); }}
      style={[styles.row, lit ? styles.rowLit : null]}
    >
      {body}
    </Pressable>
  );
}

/** A link out to Google Maps: an <a href> in a new tab on web, Linking on native (as SourceChip opens a source). */
function MapsLink(props: { url: string; label: string; onLight?: (on: boolean) => void }): React.JSX.Element {
  const open = Platform.OS === 'web'
    ? { href: props.url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } }
    : { onPress: () => { void Linking.openURL(props.url).catch(() => undefined); } };
  return (
    <Pressable
      role="link"
      accessibilityLabel={props.label}
      {...open}
      onFocus={() => { props.onLight?.(true); }}
      onBlur={() => { props.onLight?.(false); }}
      style={styles.mapsLink}
    >
      {({ hovered }: { hovered?: boolean }) => (
        <Text style={[styles.mapsText, hovered === true ? styles.mapsHover : null]}>{LOCATIONS_MAP_COPY.openInMaps}</Text>
      )}
    </Pressable>
  );
}

const PIN = 24;

const styles = StyleSheet.create({
  // Clipped, so nothing over the map (a target, the ring, a label) can reach outside it.
  frame: { width: '100%', maxWidth: 640, position: 'relative', overflow: 'hidden' },
  /** A pin's tip sits on its point; the target covers its head above. */
  anchor: { position: 'absolute', width: 0, height: 0 },
  target: { position: 'absolute', left: -16, top: -42, width: 32, height: 42, borderRadius: 16 },
  targetLit: { borderWidth: 2, borderColor: theme.color.white, backgroundColor: theme.color.mintRing },
  label: { position: 'absolute', width: 240 },
  labelAbove: { bottom: 46 },
  labelBelow: { top: 6 },
  labelCenter: { left: -120, alignItems: 'center' },
  labelLeft: { left: -16, alignItems: 'flex-start' },
  labelRight: { right: -16, alignItems: 'flex-end' },
  labelText: {
    ...theme.type.small, color: theme.color.white, backgroundColor: theme.color.panel,
    borderWidth: 1, borderColor: theme.color.border, paddingHorizontal: theme.space[2], paddingVertical: theme.space[1], overflow: 'hidden',
  },
  rowLit: { backgroundColor: theme.color.raised },
  pinLit: { borderWidth: 2, borderColor: theme.color.white },
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
  // As LinkButton's link variant (ui/Button.tsx), so the row's two links match.
  mapsText: { ...theme.type.ui, color: theme.color.white, textDecorationLine: 'underline', textDecorationColor: theme.color.line },
  mapsHover: { color: theme.color.mint, textDecorationColor: theme.color.mint },
});
