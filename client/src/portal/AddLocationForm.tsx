import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';

import { createLocation, type TownInput } from './api';
import { CONTACT_EMAIL } from './contact';
import { hasCode } from './errors';
import { useAction } from './hooks';
import { addLabel } from './onboarding/checklist';
import { PlaceChecklist } from './onboarding/PlaceChecklist';
import { createLocationAt, placeChanged, placeName, placesUnavailable, townInputOf, type UsablePlace } from './onboarding/places';
import { usePlaceChecklist, type CheckedRow } from './onboarding/usePlaceChecklist';
import { usePlaceSearchAvailability } from './onboarding/usePlaceSearch';
import { usePortal, useReadOnly } from './PortalProvider';
import { locationHref } from './routing';
import { Actions, Button } from './ui/Button';
import { ErrorNotice, ReadOnlyLine } from './ui/feedback';
import { FormField } from './ui/FormField';
import { Stack } from './ui/layout';
import { checkTown, EMPTY_TOWN, TOWN_COPY, TownFields, townValueOf, type TownMessages, type TownValue } from './ui/TownFields';

// The Add location form (spec P10; inline on Locations when an org admin has none yet, P9). While the Google Places
// search is on (GET /api/org `placeSearch`), the form starts with the places checklist (onboarding/usePlaceChecklist.ts):
// each checked place has a Name, starting from Google's, and the primary “Add location” or “Add {n} locations” sends
// them one after another to POST /api/org/locations, each with its place. Each row then says how it went: an added
// row leaves, a taken name or a place Google now answers differently says so on its row and the rest go on, and the
// location limit, a 503 or any other failure stops the rest (the 503 on its row, any other with Try again for the rows
// left). The organization reloads when any was added, and once none is left the Home of the first this press added
// opens. While it reloads the search stays as the last read had it, and P9 keeps the form while rows are left
// (`onRowsLeft`). “Can’t find it? Enter it yourself” opens Name and Town, which add one location without a place
// (after a row's 503, starting from that row). With the search off, under view-as, and after the search's 503, the
// form is Name and Town alone. P21's staff setup (D23) mounts the same form with a `target` of its own: its route,
// what follows, and the search's availability.

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

type Mode = { kind: 'search' } | { kind: 'manual' };

interface Added { id: string; name: string }

/** Where the form sends a location in place of P10's POST /api/org/locations, and what follows. */
export interface AddLocationTarget {
  /** Sends one, with its place's id or null; null when the target handled a refusal of its own, which stops the rest. */
  create: (input: { name: string; town: TownInput }, placeId: string | null) => Promise<Added | null>;
  /**
   * After a press added locations, in the order added; `finished` when none is left to add. The form stays pending
   * until it settles.
   */
  onAdded: (locations: readonly Added[], finished: boolean) => Promise<void>;
  /** Whether the Google Places search is on. */
  placeSearch: boolean;
  /** 409 location_limit, in the target's words. */
  limitLine: string;
}

/** A checked row's Name as typed (null: still Google's), the Name's message, and a line about its place. */
interface RowEdit { name: string | null; message: string | null; line: string | null }

const NO_EDIT: RowEdit = { name: null, message: null, line: null };

/** Edits keyed by the row's place: checking a place again makes a new one, so its row starts over. */
type Edits = ReadonlyMap<UsablePlace, RowEdit>;

function withEdit(edits: Edits, place: UsablePlace, patch: Partial<RowEdit>): Edits {
  return new Map(edits).set(place, { ...(edits.get(place) ?? NO_EDIT), ...patch });
}

/** One checked row as a press sends it. */
interface Pending { key: string; place: UsablePlace; input: { name: string; town: TownInput } }

export function AddLocationForm(props: {
  target?: AddLocationTarget;
  /**
   * After a press that added any (P10's own route only): true while rows are left, false once none is. P9 keeps the
   * form in place while it is true, since the organization the press reloads would otherwise move that page on and
   * lose the rows left.
   */
  onRowsLeft?: (left: boolean) => void;
}): React.JSX.Element {
  const { target, onRowsLeft } = props;
  const { api, org, reloadOrg } = usePortal();
  const router = useRouter();
  const { readOnly, line } = useReadOnly();
  const orgSearch = org?.status === 'ready' ? org.data.placeSearch === true : null;
  // The last read's answer, so the search and its rows stay while the organization reads again after a press.
  const [lastSearch, setLastSearch] = useState(orgSearch ?? false);
  if (orgSearch !== null && orgSearch !== lastSearch) setLastSearch(orgSearch);
  const known = target === undefined ? (orgSearch ?? lastSearch) : target.placeSearch;
  const search = usePlaceSearchAvailability(api, { known, readOnly });
  const checklist = usePlaceChecklist(api, PLACE_COPY.unavailable);
  const { remove } = checklist;
  const [chosen, setMode] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (search === 'on' ? { kind: 'search' } : { kind: 'manual' });
  const [name, setName] = useState('');
  const [town, setTown] = useState<TownValue>(EMPTY_TOWN);
  const [messages, setMessages] = useState<Messages>({});
  const [edits, setEdits] = useState<Edits>(() => new Map());
  const [limit, setLimit] = useState(false);
  // Google stopped answering in this visit: the search isn't offered again.
  const [down, setDown] = useState(false);
  const readOnlyId = 'add-location-ro';
  const ro = readOnly ? { readOnly: true, readOnlyId } : {};

  const send = useCallback((input: { name: string; town: TownInput }, placeId: string | null): Promise<Added | null> => {
    if (target !== undefined) return target.create(input, placeId);
    return placeId === null ? createLocation(api, input) : createLocationAt(api, input, placeId);
  }, [api, target]);

  /** After a press that added any: the organization reloads, and once none is left the first one's Home opens. */
  const after = useCallback(async (added: readonly Added[], finished: boolean): Promise<void> => {
    const [first] = added;
    if (first === undefined) return;
    if (target !== undefined) {
      await target.onAdded(added, finished);
      return;
    }
    // Before the reload, in the same render, so P9 never swaps the form for its loading line.
    onRowsLeft?.(!finished);
    reloadOrg();
    if (finished) router.push(locationHref(first.id));
  }, [onRowsLeft, reloadOrg, router, target]);

  const addByHand = useAction(useCallback(async (input: { name: string; town: TownInput }) => {
    let added: Added | null;
    try {
      added = await send(input, null);
    } catch (error) {
      if (hasCode(error, 409, 'location_name_taken')) { setMessages({ name: LOCATION_COPY.taken }); return; }
      if (hasCode(error, 409, 'location_limit')) { setLimit(true); return; }
      if (hasCode(error, 400, 'unknown_town')) { setMessages({ town: { choice: TOWN_COPY.choice } }); return; }
      throw error;
    }
    if (added !== null) await after([added], true);
  }, [send, after]));

  const addPlaces = useAction(useCallback(async (rows: readonly Pending[]) => {
    const mark = (place: UsablePlace, patch: Partial<RowEdit>): void => { setEdits((current) => withEdit(current, place, patch)); };
    const added: Added[] = [];
    let handled = false;
    try {
      for (const row of rows) {
        let location: Added | null;
        try {
          location = await send(row.input, row.place.placeId);
        } catch (error) {
          if (hasCode(error, 409, 'location_name_taken')) { mark(row.place, { message: LOCATION_COPY.taken }); continue; }
          if (placeChanged(error)) { mark(row.place, { line: PLACE_COPY.changed }); continue; }
          if (hasCode(error, 409, 'location_limit')) { setLimit(true); break; }
          if (placesUnavailable(error)) { mark(row.place, { line: PLACE_COPY.notAdded }); break; }
          throw error;
        }
        if (location === null) {
          handled = true;
          break;
        }
        added.push(location);
        remove(row.key);
      }
    } catch (error) {
      // What the press added still counts, and the notice reports the batch's own failure, not a later one.
      await after(added, false).catch(() => undefined);
      throw error;
    }
    if (!handled) await after(added, added.length === rows.length);
  }, [send, after, remove]));

  // Rows a press left, then removed by hand: nothing is left for P9 to hold the form for.
  const empty = checklist.rows.length === 0;
  const adding = addPlaces.pending;
  useEffect(() => {
    if (empty && !adding) onRowsLeft?.(false);
  }, [empty, adding, onRowsLeft]);

  function submitByHand(): void {
    if (readOnly) return;
    const trimmed = name.trim();
    const checked = checkTown(town);
    const next: Messages = {};
    if (trimmed === '' || trimmed.length > 80) next.name = LOCATION_COPY.name;
    if ('messages' in checked) next.town = checked.messages;
    setMessages(next);
    setLimit(false);
    if (next.name !== undefined || !('input' in checked)) return;
    addByHand.run({ name: trimmed, town: checked.input });
  }

  /** Checks every row's Name, then sends the rows in order; with a bad Name nothing is sent. */
  function submitPlaces(): void {
    if (readOnly || checklist.loading) return;
    const next = new Map<UsablePlace, RowEdit>();
    const rows: Pending[] = [];
    for (const row of checklist.rows) {
      if (row.status !== 'checked') continue;
      const edit = edits.get(row.place) ?? NO_EDIT;
      const trimmed = (edit.name ?? placeName(row.place)).trim();
      const bad = trimmed === '' || trimmed.length > 80;
      next.set(row.place, { name: edit.name, message: bad ? LOCATION_COPY.name : null, line: null });
      rows.push({ key: row.key, place: row.place, input: { name: trimmed, town: townInputOf(row.place.town) } });
    }
    setEdits(next);
    setLimit(false);
    if ([...next.values()].some((edit) => edit.message !== null)) return;
    addPlaces.run(rows);
  }

  /** Opens Name and Town; after a row's 503 (“Check the town, then add the location without it”) they start from that row. */
  function enterByHand(): void {
    const notAdded = checklist.rows.find((row): row is CheckedRow => row.status === 'checked' && edits.get(row.place)?.line === PLACE_COPY.notAdded);
    if (notAdded !== undefined) {
      setName((edits.get(notAdded.place)?.name ?? placeName(notAdded.place)).trim());
      setTown(townValueOf(notAdded.place.town));
    }
    setMode({ kind: 'manual' });
  }

  const onUnavailable = useCallback((): void => {
    setDown(true);
    setMode({ kind: 'manual' });
  }, []);

  const limitNotice = limit ? <ErrorNotice message={target?.limitLine ?? LOCATION_COPY.limit} /> : null;

  if (mode.kind === 'search') {
    const count = checklist.places.length;
    return (
      <Stack gap={20}>
        <PlaceChecklist
          state={checklist}
          autoFocus={chosen !== null}
          label="Search Google Maps for the location"
          helper="Type its name. Google Maps suggests places in the US."
          disabled={addPlaces.pending}
          onUnavailable={onUnavailable}
          rowExtra={(row) => {
            const edit = edits.get(row.place) ?? NO_EDIT;
            // Read-only while adding: the press has read each Name, so one typed now would not be the one sent.
            return (
              <>
                <FormField
                  label="Name"
                  value={edit.name ?? placeName(row.place)}
                  onChangeText={(text) => { setEdits((current) => withEdit(current, row.place, { name: text })); }}
                  autoCapitalize="words"
                  maxLength={80}
                  messages={edit.message === null ? [] : [edit.message]}
                  readOnly={addPlaces.pending}
                />
                {edit.line === null ? null : <ErrorNotice message={edit.line} />}
              </>
            );
          }}
        />
        {limitNotice}
        {addPlaces.error === null ? null : <ErrorNotice error={addPlaces.error} onRetry={submitPlaces} />}
        <Actions>
          <Button label={addLabel(count)} disabled={count === 0 || checklist.loading || addPlaces.pending} onPress={submitPlaces} />
          <Button variant="link" label="Can’t find it? Enter it yourself" disabled={addPlaces.pending} onPress={enterByHand} />
        </Actions>
      </Stack>
    );
  }

  return (
    <Stack gap={20}>
      <ReadOnlyLine text={line} nativeID={readOnlyId} />
      {down ? <ErrorNotice message={PLACE_COPY.unavailable} /> : null}
      <FormField
        label="Name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        maxLength={80}
        messages={messages.name === undefined ? [] : [messages.name]}
        {...ro}
      />
      <TownFields value={town} onChange={setTown} {...(messages.town === undefined ? {} : { messages: messages.town })} {...ro} />
      {limitNotice}
      {addByHand.error === null ? null : <ErrorNotice error={addByHand.error} onRetry={submitByHand} />}
      <Actions>
        <Button
          label="Add location"
          disabled={readOnly || addByHand.pending}
          {...(readOnly ? { describedBy: readOnlyId } : {})}
          onPress={submitByHand}
        />
        {search === 'on' && !down
          ? <Button variant="link" label="Search Google Maps instead" onPress={() => { setMode({ kind: 'search' }); }} />
          : null}
      </Actions>
    </Stack>
  );
}
