import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { LOCATION_COPY } from '../AddLocationForm';
import type { TownInput } from '../api';
import { hasCode } from '../errors';
import { useAction, useBreakpoint } from '../hooks';
import { PlaceSearch } from '../onboarding/PlaceSearch';
import { placeChanged, placesUnavailable, townInputOf, townLabel, type UsablePlace } from '../onboarding/places';
import { usePlaceSearchAvailability } from '../onboarding/usePlaceSearch';
import { SCRIPT_FOCUS, useFocusOnMount } from '../places/focus';
import { GOOGLE_SOURCE, PlaceSummary } from '../places/PlaceCard';
import { PlaceMap } from '../places/PlaceMap';
import { usePlacesMap } from '../places/usePlacesMap';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ErrorNotice, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Columns, Section, Stack } from '../ui/layout';
import { Small } from '../ui/text';
import { checkTown, TOWN_COPY, TownFields, townValueOf, type TownMessages, type TownValue } from '../ui/TownFields';
import { theme } from '../../theme';
import { deleteLocation, updateLocation } from './api';
import { defaultLocationName, shownLocationName } from './naming';

// P16 Location settings (spec 16.3, org admins; the route guard sends members to Locations): Name and Town with
// “Save changes”, then Delete location (D44), which deletes the location with all its data behind a typed-name
// confirmation whose body counts the days and notes that go with it. Saving reloads the organization, so the header shows the new name, and the page shows
// “Saved.”; deleting opens Locations with “Deleted {name}.”. A 404 on either write means the location was deleted
// in the meantime: the organization reloads, and the location layout says “This location isn’t available.” with
// the link to Locations (spec 10.9). Under view-as every write is disabled in place.
// While the Google Places search is on (GET /api/org `placeSearch`), D47: the first section is “Name and place”, and
// the location's place on Google Maps leads it, under Name: the map of its place (when it has one and the map is on),
// the line that says whether it is linked, and “Change this location’s place” (or “Find …”), which opens the search.
// “Use this place” holds the place in the form (its map and summary, “Change place”, “Don’t use this place”) and fills
// Name with D29's default for it unless the person typed in Name first; nothing is saved until “Save changes” sends
// name, town and place in one PATCH. The town shows as text; the Town fields open only behind “Enter the town
// yourself” (not while a place is held), since a town changed by hand takes the place off (api/README.md,
// Organization and locations). With the search off, the section is “Name and town” with the Town fields, as before.
// Focus: the search field when it opens, the place's summary after “Use this place”, and the linked line when the
// search or the held place closes.

const READ_ONLY_ID = 'location-settings-ro';

/** Delete location (D44): one press takes the location and everything in it. */
export const DELETE_COPY = {
  kicker: 'Can’t be undone',
  line: 'Deletes this location with everything in it: its sales data, stored files, notes, business rules, ordering setup, calendars and TownwiseAI chats.',
  reading: 'Townwise is reading files for this location. Try again when it’s done.',
  filesOff: 'Stored files are off right now, so nothing was deleted. Try again later.',
} as const;

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

const REST = 'its stored files, business rules, ordering setup, calendars and TownwiseAI chats';

/**
 * The dialog's body: what goes with the location. The days count those turned-off uploads hold too, which coverage
 * leaves out; files, item sales and the rest are always named, since the organization's summary doesn't count them.
 */
export function deleteBody(location: { coverage: { dayCount: number }; offDayCount?: number | undefined; notesCount: number }, orgName: string): string {
  const days = location.coverage.dayCount + (location.offDayCount ?? 0);
  const counted = days === 0 && location.notesCount === 0
    ? ''
    : `${count(days, 'day', 'days')} of sales data, ${count(location.notesCount, 'note', 'notes')}, `;
  return `This deletes the location from ${orgName} with everything in it: ${counted}${REST}. This can’t be undone.`;
}

function deleteErrorText(error: unknown): string | undefined {
  if (hasCode(error, 409, 'import_running')) return DELETE_COPY.reading;
  if (hasCode(error, 503, 'files_unavailable')) return DELETE_COPY.filesOff;
  return undefined;
}

export const PLACE_SETTINGS_COPY = {
  linked: 'Linked to a place on Google Maps. Townwise keeps Google’s id for it and its town.',
  unlinked: 'Not linked to a place on Google Maps.',
  byHand: 'Changing the town here takes the Google Maps place off this location.',
  townByHand: 'Enter the town yourself',
  placeLabel: 'Place on Google Maps',
  unavailable: 'Google Maps isn’t answering right now. Nothing changed; try again later.',
  changed: 'Google Maps answered differently this time. Nothing changed; search for the place again.',
  /** D47: under Name once a picked place filled it in. */
  prefilled: 'From Google Maps. Change it if you like; it’s saved as this location’s name when you save.',
} as const;

interface Messages { name?: string; town?: TownMessages }

export function LocationSettings(): React.JSX.Element {
  const { location, org } = useLocation();
  // With one location, every line names the organization (D29); the Name field still holds the location's own name,
  // which shows once there is a second location.
  const shown = shownLocationName(location, org);
  const several = org.locations.length > 1;
  const { api, reloadOrg, showNotice } = usePortal();
  const router = useRouter();
  const { readOnly, line } = useReadOnly();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const ro = readOnly ? { readOnly: true, readOnlyId: READ_ONLY_ID } : {};
  const [name, setName] = useState(location.name);
  /** Whether the person typed in Name this visit: a picked place then offers its name instead of filling it in. */
  const [nameTyped, setNameTyped] = useState(false);
  /** D47: the place picked in the search, held in the form until Save changes sends it with the name and town. */
  const [picked, setPicked] = useState<{ place: UsablePlace; name: string; prefilled: boolean } | null>(null);
  const [town, setTown] = useState<TownValue>(() => townValueOf(location.town));
  const [messages, setMessages] = useState<Messages>({});
  const [confirming, setConfirming] = useState(false);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  const settingsPath = locationHref(location.id, 'settings');
  const search = usePlaceSearchAvailability(api, { known: org.placeSearch === true, readOnly: false });
  const [finding, setFinding] = useState(false);
  /** How many times the search closed: the linked line remounts with each, and takes focus (useFocusOnMount). */
  const [closed, setClosed] = useState(0);
  const stopFinding = useCallback((): void => { setFinding(false); setClosed((n) => n + 1); }, []);
  const [placeLine, setPlaceLine] = useState<string | null>(null);
  // The place the last place save answered, until the organization's reload shows it: the linked line is right when
  // it takes focus, not a moment later.
  const [savedPlaceId, setSavedPlaceId] = useState<string | null>(null);
  if (savedPlaceId !== null && location.placeId === savedPlaceId) setSavedPlaceId(null);
  const linked = savedPlaceId !== null || (location.placeId !== undefined && location.placeId !== null);
  const placeId = savedPlaceId ?? location.placeId ?? null;
  const placeMap = usePlacesMap(api, search === 'on' && placeId !== null ? [placeId] : []);
  /** D47: with the search on, the Town fields open only on “Enter the town yourself”. */
  const [townOpen, setTownOpen] = useState(false);
  const townShown = search !== 'on' || townOpen;

  /** D47: a place picked in the search goes into the form with its default name (D29), unsaved. */
  const pick = useCallback((place: UsablePlace): void => {
    const suggested = defaultLocationName(place, org.org.name);
    // A name that is the last held place's own default came from Google, not the person: the new place's replaces it.
    const fill = !nameTyped || (picked !== null && name === picked.name);
    setPicked({ place, name: suggested, prefilled: fill });
    if (fill) setName(suggested);
    setTown(townValueOf(place.town));
    setTownOpen(false);
    setPlaceLine(null);
    setFinding(false);
    // The linked line comes back after Save or Don't use this place, and takes focus then.
    setClosed((n) => n + 1);
  }, [org.org.name, nameTyped, picked, name]);

  /** The picked place leaves the form: the name it filled in goes back, a name the person typed stays. */
  const dropPicked = useCallback((): void => {
    // Compared with the name as it is now, so an edit made while a save was pending stays.
    if (picked?.prefilled === true) setName((current) => (current === picked.name ? location.name : current));
    setTown(townValueOf(location.town));
    setPicked(null);
    stopFinding();
  }, [picked, location.name, location.town, stopFinding]);

  const save = useAction(useCallback(async (input: { name: string; town: TownInput; placeId?: string }) => {
    let saved;
    try {
      saved = await updateLocation(api, location.id, input);
    } catch (error) {
      if (hasCode(error, 409, 'location_name_taken')) { setMessages({ name: LOCATION_COPY.taken }); return; }
      if (hasCode(error, 400, 'unknown_town')) { setMessages({ town: { choice: TOWN_COPY.choice } }); return; }
      if (hasCode(error, 404, 'not_found')) { reloadOrg(); return; }
      // A place Google now answers differently, or Google not answering: nothing was saved, and the place leaves the form.
      if (input.placeId !== undefined && placesUnavailable(error)) { dropPicked(); setPlaceLine(PLACE_SETTINGS_COPY.unavailable); return; }
      if (input.placeId !== undefined && placeChanged(error)) { dropPicked(); setPlaceLine(PLACE_SETTINGS_COPY.changed); return; }
      throw error;
    }
    // The organization reloads, so the header shows the new name; the notice shows once this page is back. A town
    // changed by hand may have taken the place off: the reload says.
    setSavedPlaceId(input.placeId === undefined ? null : (saved.placeId ?? null));
    setPicked(null);
    setNameTyped(false);
    showNotice({ text: 'Saved.' }, settingsPath);
    reloadOrg();
  }, [api, location.id, reloadOrg, showNotice, settingsPath, dropPicked]));

  const remove = useAction(useCallback(async () => {
    try {
      await deleteLocation(api, location.id);
    } catch (error) {
      if (hasCode(error, 404, 'not_found')) { setConfirming(false); reloadOrg(); return; }
      throw error;
    }
    // Locations, or the one location left, whose Home Locations opens.
    showNotice({ text: `Deleted ${shown}.` }, /^\/(dashboard|locations\/[^/]+)$/);
    reloadOrg();
    router.replace('/dashboard');
  }, [api, location.id, shown, reloadOrg, router, showNotice]));

  const deleteMessage = deleteErrorText(remove.error);

  function submit(): void {
    if (readOnly) return;
    const trimmed = name.trim();
    // D47: a picked place sends its own town and id; otherwise, with the Town fields closed, the town shown (the
    // location's, after any reload) is the one sent.
    const checked = picked !== null ? { input: townInputOf(picked.place.town) } : checkTown(townShown ? town : townValueOf(location.town));
    const next: Messages = {};
    if (trimmed === '' || trimmed.length > 80) next.name = LOCATION_COPY.name;
    if ('messages' in checked) next.town = checked.messages;
    setMessages(next);
    if (next.name !== undefined || !('input' in checked)) return;
    save.run(picked === null ? { name: trimmed, town: checked.input } : { name: trimmed, town: checked.input, placeId: picked.place.placeId });
  }

  const placePart = search === 'on' ? (
    <Stack gap={12}>
      <Text style={[theme.type.label, styles.label]}>{PLACE_SETTINGS_COPY.placeLabel}</Text>
      {placeId === null || finding || picked !== null ? null : <PlaceMap map={placeMap} label={`Map of ${shown}`} frame={styles.map} />}
      {picked === null ? <LinkedLine key={closed} text={linked ? PLACE_SETTINGS_COPY.linked : PLACE_SETTINGS_COPY.unlinked} focus={closed > 0} /> : null}
      {placeLine === null ? null : <ErrorNotice message={placeLine} />}
      {finding && !readOnly ? (
        <PlaceSearch
          api={api}
          autoFocus
          label="Search Google Maps for this location"
          helper="Type its name. Google Maps suggests places in the US."
          confirmLabel="Use this place"
          note={(place) => (place.town === null || sameTownLabel(place.town, location.town)
            ? null
            : `Using this place moves ${shown} to ${townLabel(place.town)}.`)}
          onConfirm={pick}
          manualLabel="Cancel"
          onManual={stopFinding}
          onUnavailable={() => { stopFinding(); setPlaceLine(PLACE_SETTINGS_COPY.unavailable); }}
        />
      ) : picked !== null ? (
        <>
          <PlaceMap map={picked.place.map} label={`Map of ${picked.place.name}`} frame={styles.map} />
          <PlaceSummary places={[picked.place]} source={GOOGLE_SOURCE} focusOnMount>
            <Actions>
              <Button variant="outline" label="Change place" onPress={() => { setFinding(true); }} />
              <Button
                variant="link"
                label="Don’t use this place"
                onPress={dropPicked}
              />
            </Actions>
          </PlaceSummary>
          {picked.prefilled || name.trim() === picked.name ? null : (
            <Actions>
              <Button variant="link" label={`Use “${picked.name}” as the name`} onPress={() => { setName(picked.name); setPicked({ ...picked, prefilled: true }); }} />
            </Actions>
          )}
        </>
      ) : (
        <Actions>
          <Button
            variant="outline"
            label={linked ? 'Change this location’s place' : 'Find this location’s place'}
            disabled={readOnly}
            {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
            onPress={() => { setPlaceLine(null); setFinding(true); }}
          />
        </Actions>
      )}
    </Stack>
  ) : null;

  return (
    <View>
      <Section first kicker="Location" title={search === 'on' ? 'Name and place' : 'Name and town'}>
        <Columns
          main={(
            <Stack gap={20}>
              {readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />}
              <FormField
                label="Name"
                value={name}
                onChangeText={(text) => { setName(text); setNameTyped(true); }}
                autoCapitalize="words"
                maxLength={80}
                {...nameHelper(picked !== null && picked.prefilled && name === picked.name, several ? null : `Shown only once ${org.org.name} has more than one location.`)}
                messages={messages.name === undefined ? [] : [messages.name]}
                {...ro}
              />
              {placePart}
              {townShown ? (
                <>
                  <TownFields autoFocus={townOpen} value={town} onChange={setTown} {...(messages.town === undefined ? {} : { messages: messages.town })} {...ro} />
                  {linked ? <Small>{PLACE_SETTINGS_COPY.byHand}</Small> : null}
                </>
              ) : (
                <Stack gap={4}>
                  <Text style={[theme.type.label, styles.label]}>Town</Text>
                  <Small>{townLabel(picked === null ? location.town : picked.place.town)}</Small>
                  {/* A held place brings its own town; to enter one by hand, Don't use this place first. */}
                  {picked !== null ? null : (
                    <Actions>
                      <Button
                        variant="link"
                        label={PLACE_SETTINGS_COPY.townByHand}
                        disabled={readOnly}
                        {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
                        onPress={() => { setTownOpen(true); }}
                      />
                    </Actions>
                  )}
                </Stack>
              )}
              {save.error === null ? null : <ErrorNotice error={save.error} onRetry={submit} />}
              <Actions>
                <Button
                  label={save.pending ? 'Saving…' : 'Save changes'}
                  disabled={readOnly || save.pending}
                  {...(readOnlyId === null ? {} : { describedBy: readOnlyId })}
                  onPress={submit}
                />
              </Actions>
            </Stack>
          )}
          side={(
            <Stack>
              <Small>Another restaurant is its own location, with its own sales, notes and forecast.</Small>
              {/* Straight to Add location: with one location, Locations opens this Home (P9). */}
              <Actions>
                <LinkButton
                  variant="outline"
                  href="/locations/new"
                  label="Add another location"
                  {...(readOnlyId === null ? {} : { disabled: true, describedBy: readOnlyId })}
                />
              </Actions>
            </Stack>
          )}
        />
      </Section>
      <Section kicker="TownwiseAI" title="Business rules">
        <Columns
          main={(
            <Stack>
              <Small>{`The standing facts TownwiseAI keeps in mind for ${shown}. Only a rule with a schedule changes Townwise’s forecast.`}</Small>
              <Actions>
                <LinkButton variant="outline" href={locationHref(location.id, 'rules')} label="Edit business rules" />
              </Actions>
            </Stack>
          )}
        />
      </Section>
      <Section kicker={DELETE_COPY.kicker} title="Delete location">
        <Columns
          main={(
            <Stack>
              <Small>{DELETE_COPY.line}</Small>
              <Actions>
                {readOnlyId === null
                  ? <Button variant="outline" label="Delete location" onPress={() => { setStaleError(remove.error); setConfirming(true); }} />
                  : <Button variant="outline" label="Delete location" disabled describedBy={readOnlyId} />}
              </Actions>
            </Stack>
          )}
        />
      </Section>
      <ConfirmDialog
        visible={confirming}
        title={`Delete ${shown}?`}
        body={deleteBody(location, org.org.name)}
        typedName={shown}
        confirmLabel="Delete location"
        pendingLabel="Deleting…"
        pending={remove.pending}
        error={remove.error === staleError ? null : remove.error}
        {...(deleteMessage === undefined ? {} : { errorMessage: deleteMessage })}
        onConfirm={() => { remove.run(); }}
        onCancel={() => { setConfirming(false); }}
      />
    </View>
  );
}

/** Whether the location is linked: Small's text (ui/text.tsx) with a ref, to take focus when the search closes. */
function LinkedLine(props: { text: string; focus: boolean }): React.JSX.Element {
  const { phone } = useBreakpoint();
  const line = useFocusOnMount<React.ComponentRef<typeof Text>>(props.focus);
  return (
    <Text ref={line} {...SCRIPT_FOCUS} style={[phone ? theme.type.sub : theme.type.small, styles.linked]}>
      {props.text}
    </Text>
  );
}

/** Name's helper: the prefill line while Name holds a picked place's default, and D29's line with one location. */
function nameHelper(prefilled: boolean, oneLocation: string | null): { helper?: string } {
  const parts = [prefilled ? PLACE_SETTINGS_COPY.prefilled : null, oneLocation].filter((part) => part !== null);
  return parts.length === 0 ? {} : { helper: parts.join(' ') };
}

/** The same town by name and state, as the card shows it. */
function sameTownLabel(a: { name: string; state: string }, b: { name: string; state: string }): boolean {
  return a.name.toLowerCase() === b.name.toLowerCase() && a.state === b.state;
}

const styles = StyleSheet.create({
  linked: { color: theme.color.text2 },
  label: { color: theme.color.text3 },
  map: { width: '100%', maxWidth: 640 },
});
