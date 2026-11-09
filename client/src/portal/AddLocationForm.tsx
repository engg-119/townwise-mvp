import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';

import { createLocation, openAsAdminOrgId, type TownInput } from './api';
import { CONTACT_EMAIL } from './contact';
import { hasCode } from './errors';
import { useAction } from './hooks';
import { PlaceSearch } from './onboarding/PlaceSearch';
import { createLocationAt, placeChanged, placesUnavailable, townInputOf, type UsablePlace } from './onboarding/places';
import { usePlaceSearchAvailability } from './onboarding/usePlaceSearch';
import { PlaceSummary } from './places/PlaceCard';
import { usePortal, useReadOnly } from './PortalProvider';
import { locationHref } from './routing';
import { Actions, Button } from './ui/Button';
import { ErrorNotice, ReadOnlyLine } from './ui/feedback';
import { FormField } from './ui/FormField';
import { Stack } from './ui/layout';
import { checkTown, EMPTY_TOWN, TOWN_COPY, TownFields, townValueOf, type TownMessages, type TownValue } from './ui/TownFields';

// The Add location form (spec P10; inline on Locations when an org admin has none yet, P9): Name and Town, with
// the primary “Add location”. POST /api/org/locations; on success the organization reloads and the new
// location's Home opens. While the Google Places search is on (GET /api/org `placeSearch`), the form starts with it:
// the confirmed place fills Name and gives the town, and “Can’t find it? Enter it yourself” opens the fields as they
// are without it. With the search off, and under view-as, the form is the fields alone. Focus follows the steps: Looks
// right moves it to the place in the form, and Change place or Search Google Maps instead to the search field.
// P21's staff setup (D23) mounts the same form with a `target` of its own: its route, what follows, and the search's
// availability.

export const LOCATION_COPY = {
  name: 'Enter the location’s name.',
  taken: 'Another location already uses that name.',
  limit: `You’ve reached 25 locations. Write to ${CONTACT_EMAIL} for more.`,
} as const;

export const PLACE_COPY = {
  unavailable: 'Google Maps isn’t answering right now, so you can enter the location yourself.',
  notAdded: 'Google Maps isn’t answering right now, so the place wasn’t added. Check the town, then add the location without it.',
  changed: 'Google Maps answered differently this time. Search for the place again, or enter it yourself.',
} as const;

interface Messages { name?: string; town?: TownMessages }

type Mode = { kind: 'search' } | { kind: 'form'; place: UsablePlace | null };

/** Where the form sends a location in place of P10's POST /api/org/locations, and what follows. */
export interface AddLocationTarget {
  /** Sends it, with the confirmed place's id or null; null when the target handled a refusal of its own. */
  create: (input: { name: string; town: TownInput }, placeId: string | null) => Promise<{ id: string; name: string } | null>;
  /** After it is added; the form stays pending until it settles. */
  onAdded: (location: { id: string; name: string }) => Promise<void>;
  /** Whether the Google Places search is on. */
  placeSearch: boolean;
  /** 409 location_limit, in the target's words. */
  limitLine: string;
}

export function AddLocationForm(props: { target?: AddLocationTarget }): React.JSX.Element {
  const { target } = props;
  const { api, me, org, reloadOrg } = usePortal();
  const router = useRouter();
  const { readOnly, line } = useReadOnly();
  const known = target === undefined ? (org?.status === 'ready' ? org.data.placeSearch === true : false) : target.placeSearch;
  const search = usePlaceSearchAvailability(api, { known, readOnly });
  const [chosen, setMode] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (search === 'on' ? { kind: 'search' } : { kind: 'form', place: null });
  const [name, setName] = useState('');
  const [town, setTown] = useState<TownValue>(EMPTY_TOWN);
  const [messages, setMessages] = useState<Messages>({});
  const [placeLine, setPlaceLine] = useState<string | null>(null);
  const [limit, setLimit] = useState(false);
  // Google stopped answering in this visit: the search isn't offered again.
  const [down, setDown] = useState(false);
  const readOnlyId = 'add-location-ro';
  const ro = readOnly ? { readOnly: true, readOnlyId } : {};

  const add = useAction(useCallback(async (input: { name: string; town: TownInput }, place: UsablePlace | null) => {
    try {
      if (target !== undefined) {
        const added = await target.create(input, place === null ? null : place.placeId);
        if (added !== null) await target.onAdded(added);
        return;
      }
      const orgId = openAsAdminOrgId(me);
      const location = place === null ? await createLocation(api, input, orgId) : await createLocationAt(api, input, place.placeId, orgId);
      reloadOrg();
      router.push(locationHref(location.id));
    } catch (error) {
      if (hasCode(error, 409, 'location_name_taken')) { setMessages({ name: LOCATION_COPY.taken }); return; }
      if (hasCode(error, 409, 'location_limit')) { setLimit(true); return; }
      if (hasCode(error, 400, 'unknown_town')) { setMessages({ town: { choice: TOWN_COPY.choice } }); return; }
      if (place !== null && placesUnavailable(error)) {
        // The fields as they are without the search, with the place's town filled in.
        setTown(townValueOf(place.town));
        setDown(true);
        setMode({ kind: 'form', place: null });
        setPlaceLine(PLACE_COPY.notAdded);
        return;
      }
      if (place !== null && placeChanged(error)) { setMode({ kind: 'search' }); setPlaceLine(PLACE_COPY.changed); return; }
      throw error;
    }
  }, [api, me, reloadOrg, router, target]));

  function submit(place: UsablePlace | null): void {
    if (readOnly) return;
    const trimmed = name.trim();
    const checked = place === null ? checkTown(town) : { input: townInputOf(place.town) };
    const next: Messages = {};
    if (trimmed === '' || trimmed.length > 80) next.name = LOCATION_COPY.name;
    if ('messages' in checked) next.town = checked.messages;
    setMessages(next);
    setLimit(false);
    if (next.name !== undefined || !('input' in checked)) return;
    add.run({ name: trimmed, town: checked.input }, place);
  }

  if (mode.kind === 'search') {
    return (
      <Stack gap={20}>
        {placeLine === null ? null : <ErrorNotice message={placeLine} />}
        <PlaceSearch
          api={api}
          autoFocus={chosen !== null}
          label="Search Google Maps for the location"
          helper="Type its name. Google Maps suggests places in the US."
          confirmLabel="Looks right"
          onConfirm={(place) => {
            if (name.trim() === '') setName(place.name.slice(0, 80));
            setPlaceLine(null);
            setMode({ kind: 'form', place });
          }}
          manualLabel="Can’t find it? Enter it yourself"
          onManual={() => { setPlaceLine(null); setMode({ kind: 'form', place: null }); }}
          onUnavailable={() => { setPlaceLine(PLACE_COPY.unavailable); setDown(true); setMode({ kind: 'form', place: null }); }}
        />
      </Stack>
    );
  }

  const { place } = mode;
  return (
    <Stack gap={20}>
      <ReadOnlyLine text={line} nativeID={readOnlyId} />
      {placeLine === null ? null : <ErrorNotice message={placeLine} />}
      <FormField
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        maxLength={80}
        messages={messages.name === undefined ? [] : [messages.name]}
        {...ro}
      />
      {place === null
        ? <TownFields value={town} onChange={setTown} {...(messages.town === undefined ? {} : { messages: messages.town })} {...ro} />
        : (
          <PlaceSummary place={place} focusOnMount>
            <Actions>
              <Button variant="outline" label="Change place" onPress={() => { setMode({ kind: 'search' }); }} />
            </Actions>
          </PlaceSummary>
        )}
      {limit ? <ErrorNotice message={target?.limitLine ?? LOCATION_COPY.limit} /> : null}
      {add.error === null ? null : <ErrorNotice error={add.error} onRetry={() => { submit(place); }} />}
      <Actions>
        <Button
          label="Add location"
          disabled={readOnly || add.pending}
          {...(readOnly ? { describedBy: readOnlyId } : {})}
          onPress={() => { submit(place); }}
        />
        {place === null && search === 'on' && !down
          ? <Button variant="link" label="Search Google Maps instead" onPress={() => { setPlaceLine(null); setMode({ kind: 'search' }); }} />
          : null}
      </Actions>
    </Stack>
  );
}
