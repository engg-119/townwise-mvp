import { useCallback, useState } from 'react';

import { AddLocationForm, LOCATION_COPY, type AddLocationTarget } from '../AddLocationForm';
import type { TownInput } from '../api';
import { hasCode } from '../errors';
import { formatCount, formatDate, plural, townLabel } from '../format';
import { useAction } from '../hooks';
import { PlaceSearch } from '../onboarding/PlaceSearch';
import { placeChanged, placesUnavailable, townInputOf, type UsablePlace } from '../onboarding/places';
import { usePlaceSearchAvailability } from '../onboarding/usePlaceSearch';
import { PLACE_SETTINGS_COPY } from '../locations/LocationSettings';
import { defaultLocationName } from '../locations/naming';
import { GOOGLE_SOURCE, PlaceSummary } from '../places/PlaceCard';
import { usePortal } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { DataTable } from '../ui/DataTable';
import { ErrorNotice, LoadingLine, Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Columns, Section, Stack } from '../ui/layout';
import { useFocusMessage } from '../ui/messageFocus';
import { Heading, Small } from '../ui/text';
import { checkTown, TOWN_COPY, TownFields, townValueOf, type TownMessages, type TownValue } from '../ui/TownFields';
import { createSetupLocation, deleteSetupLocation, deleteSetupSales, updateSetupLocation } from './api';
import { Dialog } from './Dialog';
import { CellLines, RowActions } from './parts';
import { problemOf } from './problems';
import type { OrgLocation, SetupSalesDeleted } from './schemas';
import { SetupUpload } from './SetupUpload';

// P21's setup panel (spec 16.4, D23, F10b): shown only while the organization is in setup (`org.inSetup`: active, and
// nobody has ever joined it). Staff add its locations (P10's AddLocationForm, with the setup route), rename them or
// change their town or place (as P16), delete their sales data, delete an empty one, and upload daily totals
// (SetupUpload, web only), through the setup routes of 10.7. Every write is a staff action listed in the organization's
// Townwise staff activity; after one the page reads the organization again, so its Locations table shows the days. The
// panel shows names, towns, day counts and dates, never a figure (D7). A 409 org_not_in_setup (someone joined
// meanwhile) goes to the page, which reads again without the panel and says so; a 404 means the location (or the
// organization, which the page's read finds) was deleted meanwhile.

export interface SetupPanelProps {
  org: { id: string; name: string };
  locations: readonly OrgLocation[];
  /** Reads the organization again after a write; false when that read found it deleted (the page shows its 404 state). */
  onChanged: () => Promise<boolean>;
  /** 409 org_not_in_setup: someone joined meanwhile. */
  onClosed: () => void;
}

type Verb = 'rename' | 'deleteSales' | 'deleteLocation';

interface Acting { verb: Verb; location: OrgLocation }

/** The refusals every setup write answers alike: true when the panel handled one. */
type Settle = (error: unknown, location?: { name: string }) => Promise<boolean>;

interface DialogProps {
  org: { id: string; name: string };
  location: OrgLocation;
  settle: Settle;
  /** The write went through: the page reads again, the dialog closes and the panel says so. */
  onDone: (text: string) => Promise<void>;
  onClose: () => void;
}

const SEARCH_LABEL = 'Search Google Maps for this location';
const SEARCH_HELPER = 'Type its name. Google Maps suggests places in the US.';

interface RenameMessages { name?: string; town?: TownMessages }

type RenameMode = { kind: 'search' } | { kind: 'form'; place: UsablePlace | null };

/** Name, and the town or a place on Google Maps, as P16 offers them; one Save sends them. */
function RenameDialog(props: DialogProps & { placeSearch: boolean }): React.JSX.Element {
  const { org, location, settle, onDone, placeSearch } = props;
  const { api } = usePortal();
  const [mode, setMode] = useState<RenameMode>({ kind: 'form', place: null });
  const [name, setName] = useState(location.name);
  /** D47: a picked place fills Name with its default (D29) unless staff typed in Name in this dialog. */
  const [nameTyped, setNameTyped] = useState(false);
  const [prefilled, setPrefilled] = useState<string | null>(null);
  const [town, setTown] = useState<TownValue>(() => townValueOf(location.town));
  const [messages, setMessages] = useState<RenameMessages>({});
  const [placeLine, setPlaceLine] = useState<string | null>(null);
  /** The place leaves the dialog: a name it filled in goes back, a name staff typed stays, and so does the helper's end. */
  const leavePlace = useCallback((): void => {
    if (prefilled !== null) setName((current) => (current === prefilled ? location.name : current));
    setPrefilled(null);
  }, [prefilled, location.name]);
  // Google stopped answering in this dialog: the search isn't offered again.
  const [down, setDown] = useState(false);
  /** D47: with the search on, the Town fields open only on “Enter the town yourself”, as on P16. */
  const [townOpen, setTownOpen] = useState(false);
  const placeFirst = placeSearch && !down;
  const linked = location.hasPlace === true;

  const save = useAction(useCallback(async (patch: { name: string; town: TownInput; placeId?: string }, place: UsablePlace | null) => {
    try {
      await updateSetupLocation(api, org.id, location.id, patch);
    } catch (error) {
      if (await settle(error, location)) return;
      if (hasCode(error, 409, 'location_name_taken')) { setMessages({ name: LOCATION_COPY.taken }); return; }
      if (hasCode(error, 400, 'unknown_town')) { setMessages({ town: { choice: TOWN_COPY.choice } }); return; }
      if (place !== null && placesUnavailable(error)) {
        leavePlace();
        setDown(true);
        setMode({ kind: 'form', place: null });
        setPlaceLine(PLACE_SETTINGS_COPY.unavailable);
        return;
      }
      if (place !== null && placeChanged(error)) { leavePlace(); setMode({ kind: 'search' }); setPlaceLine(PLACE_SETTINGS_COPY.changed); return; }
      throw error;
    }
    await onDone('Saved.');
  }, [api, org.id, location, settle, onDone, leavePlace]));

  function submit(): void {
    if (mode.kind !== 'form') return;
    const { place } = mode;
    const trimmed = name.trim();
    const checked = place === null ? checkTown(town) : { input: townInputOf(place.town) };
    const next: RenameMessages = {};
    if (trimmed === '' || trimmed.length > 80) next.name = LOCATION_COPY.name;
    if ('messages' in checked) next.town = checked.messages;
    setMessages(next);
    if (next.name !== undefined || !('input' in checked)) return;
    save.run(place === null ? { name: trimmed, town: checked.input } : { name: trimmed, town: checked.input, placeId: place.placeId }, place);
  }

  let body: React.ReactNode;
  if (mode.kind === 'search') {
    body = (
      <PlaceSearch
        api={api}
        autoFocus
        label={SEARCH_LABEL}
        helper={SEARCH_HELPER}
        confirmLabel="Looks right"
        note={(place) => (place.town === null || townLabel(place.town) === townLabel(location.town)
          ? null
          : `Using this place moves ${location.name} to ${townLabel(place.town)}.`)}
        onConfirm={(place) => {
          setPlaceLine(null);
          if (!nameTyped) {
            const suggested = defaultLocationName(place, org.name);
            setName(suggested);
            setPrefilled(suggested);
          }
          setMode({ kind: 'form', place });
        }}
        manualLabel="Enter the town yourself"
        onManual={() => { leavePlace(); setPlaceLine(null); setTownOpen(true); setMode({ kind: 'form', place: null }); }}
        onUnavailable={() => { leavePlace(); setDown(true); setPlaceLine(PLACE_SETTINGS_COPY.unavailable); setMode({ kind: 'form', place: null }); }}
      />
    );
  } else {
    const { place } = mode;
    body = (
      <>
        <FormField
          label="Name"
          value={name}
          onChangeText={(text) => { setName(text); setNameTyped(true); }}
          autoCapitalize="words"
          maxLength={80}
          {...(prefilled !== null && name === prefilled ? { helper: PLACE_SETTINGS_COPY.prefilled } : {})}
          messages={messages.name === undefined ? [] : [messages.name]}
        />
        {place === null && placeFirst ? (
          <>
            {/* D47: the place leads, as on P16; the town by hand is behind its link. */}
            <Stack gap={12}>
              <Small>{linked ? PLACE_SETTINGS_COPY.linked : PLACE_SETTINGS_COPY.unlinked}</Small>
              <Actions>
                <Button
                  variant="outline"
                  label={linked ? 'Change this location’s place' : 'Find this location’s place'}
                  onPress={() => { setPlaceLine(null); setMode({ kind: 'search' }); }}
                />
              </Actions>
            </Stack>
            {townOpen ? (
              <>
                <TownFields autoFocus value={town} onChange={setTown} {...(messages.town === undefined ? {} : { messages: messages.town })} />
                {linked ? <Small>{PLACE_SETTINGS_COPY.byHand}</Small> : null}
              </>
            ) : (
              <Stack gap={4}>
                <Small>{`Town: ${townLabel(location.town)}`}</Small>
                <Actions>
                  <Button variant="link" label={PLACE_SETTINGS_COPY.townByHand} onPress={() => { setTownOpen(true); }} />
                </Actions>
              </Stack>
            )}
          </>
        ) : place === null ? (
          <>
            <TownFields value={town} onChange={setTown} {...(messages.town === undefined ? {} : { messages: messages.town })} />
            <Small>Changing the town takes off the location’s Google Maps place, if it has one.</Small>
          </>
        ) : (
          <PlaceSummary places={[place]} source={GOOGLE_SOURCE} focusOnMount>
            <Actions>
              <Button variant="outline" label="Change place" onPress={() => { setMode({ kind: 'search' }); }} />
            </Actions>
          </PlaceSummary>
        )}
      </>
    );
  }

  return (
    <Dialog
      title={`Rename ${location.name}`}
      body="Change its name, and its town or its place on Google Maps."
      confirmLabel="Save changes"
      pendingLabel="Saving…"
      pending={save.pending}
      confirmDisabled={mode.kind === 'search'}
      problem={problemOf(save.error)}
      onConfirm={submit}
      onCancel={props.onClose}
    >
      {placeLine === null ? null : <ErrorNotice message={placeLine} />}
      {body}
    </Dialog>
  );
}

function deletedLine(name: string, result: SetupSalesDeleted): string {
  const files = result.deletedFiles === 0 ? '' : ` and ${plural(result.deletedFiles, 'stored file', 'stored files')}`;
  return `Deleted ${plural(result.deletedDays, 'day', 'days')} and ${plural(result.deletedUploads, 'upload', 'uploads')}${files} from ${name}.`;
}

function salesRefusal(error: unknown): string | null {
  if (hasCode(error, 409, 'import_running')) return 'Townwise is reading files for this location. Try again when it’s done.';
  if (hasCode(error, 503, 'files_unavailable')) return 'Stored files are off right now, so nothing was deleted. Try again later.';
  return null;
}

function DeleteSalesDialog(props: DialogProps): React.JSX.Element {
  const { org, location, settle, onDone } = props;
  const { api } = usePortal();
  const remove = useAction(useCallback(async () => {
    let result: SetupSalesDeleted;
    try {
      result = await deleteSetupSales(api, org.id, location.id);
    } catch (error) {
      if (await settle(error, location)) return;
      throw error;
    }
    await onDone(deletedLine(location.name, result));
  }, [api, org.id, location, settle, onDone]));
  return (
    <Dialog
      title={`Delete ${location.name}’s sales data?`}
      body={`This deletes its ${plural(location.coverage.dayCount, 'day', 'days')} of daily totals, its uploads and any stored files. This can’t be undone. It’s listed in ${org.name}’s Townwise staff activity.`}
      typedName={location.name}
      confirmLabel="Delete sales data"
      pendingLabel="Deleting…"
      pending={remove.pending}
      problem={problemOf(remove.error, salesRefusal)}
      onConfirm={remove.run}
      onCancel={props.onClose}
    />
  );
}

function DeleteLocationDialog(props: DialogProps): React.JSX.Element {
  const { org, location, settle, onDone } = props;
  const { api } = usePortal();
  const remove = useAction(useCallback(async () => {
    try {
      await deleteSetupLocation(api, org.id, location.id);
    } catch (error) {
      if (await settle(error, location)) return;
      throw error;
    }
    await onDone(`Deleted ${location.name}.`);
  }, [api, org.id, location, settle, onDone]));
  return (
    <Dialog
      title={`Delete ${location.name}?`}
      body={`This deletes the location from ${org.name}. This can’t be undone. It’s listed in ${org.name}’s Townwise staff activity.`}
      typedName={location.name}
      confirmLabel="Delete location"
      pendingLabel="Deleting…"
      pending={remove.pending}
      problem={problemOf(remove.error, (error) => (hasCode(error, 409, 'location_has_data') ? `Delete ${location.name}’s sales data first.` : null))}
      onConfirm={remove.run}
      onCancel={props.onClose}
    />
  );
}

function daysNote(location: OrgLocation): string | null {
  const { firstDate, lastDate } = location.coverage;
  return firstDate === null || lastDate === null ? null : `${formatDate(firstDate)} to ${formatDate(lastDate)}`;
}

function SetupTable(props: { locations: readonly OrgLocation[]; onAct: (verb: Verb, location: OrgLocation) => void }): React.JSX.Element {
  const { onAct } = props;
  return (
    <DataTable
      label="Locations to set up"
      columns={[
        { key: 'name', label: 'Name', flex: 1.2 },
        { key: 'town', label: 'Town', flex: 1.1 },
        { key: 'days', label: 'Days', flex: 1.5 },
        { key: 'actions', label: 'Actions', hiddenLabel: true, flex: 2 },
      ]}
      rows={props.locations.map((location) => {
        const { dayCount } = location.coverage;
        return {
          key: location.id,
          cells: {
            name: location.name,
            town: townLabel(location.town),
            days: <CellLines main={formatCount(dayCount)} note={daysNote(location)} />,
            actions: (
              <RowActions>
                <Button variant="link" label="Rename" accessibilityLabel={`Rename ${location.name}`} onPress={() => { onAct('rename', location); }} />
                {dayCount > 0 ? (
                  <Button
                    variant="outline"
                    label="Delete sales data"
                    accessibilityLabel={`Delete ${location.name}’s sales data`}
                    onPress={() => { onAct('deleteSales', location); }}
                  />
                ) : null}
                {dayCount === 0 && location.notesCount === 0 ? (
                  <Button variant="outline" label="Delete" accessibilityLabel={`Delete ${location.name}`} onPress={() => { onAct('deleteLocation', location); }} />
                ) : null}
              </RowActions>
            ),
          },
        };
      })}
    />
  );
}

export function SetupPanel(props: SetupPanelProps): React.JSX.Element {
  const { org, locations, onChanged, onClosed } = props;
  const { api } = usePortal();
  const focusMessage = useFocusMessage();
  // One check for the panel, as P3 makes it: the add form and each Rename read it.
  const search = usePlaceSearchAvailability(api, { readOnly: false });
  const [acting, setActing] = useState<Acting | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /** Bumped once the form has added all it had, so it starts empty for the next location. */
  const [added, setAdded] = useState(0);

  /** A write went through: read the organization again, then say how it ended where focus can find it. */
  const finish = useCallback(async (text: string): Promise<boolean> => {
    if (!await onChanged()) return false;
    focusMessage();
    setActing(null);
    setDone(text);
    return true;
  }, [onChanged, focusMessage]);

  const settle = useCallback<Settle>(async (error, location) => {
    if (hasCode(error, 409, 'org_not_in_setup')) {
      onClosed();
      return true;
    }
    // The location route's 404 is the location's or the organization's: the read says which, and a deleted
    // organization's page shows its 404 state.
    if (hasCode(error, 404, 'not_found')) {
      if (location === undefined) await onChanged();
      else await finish(`${location.name} was deleted meanwhile.`);
      return true;
    }
    return false;
  }, [onClosed, onChanged, finish]);

  const onDone = useCallback(async (text: string) => { await finish(text); }, [finish]);

  const target: AddLocationTarget = {
    create: async (input, placeId) => {
      try {
        return await createSetupLocation(api, org.id, placeId === null ? input : { ...input, placeId });
      } catch (error) {
        if (await settle(error)) return null;
        throw error;
      }
    },
    onAdded: async (added, finished) => {
      const [one] = added;
      const text = added.length === 1 && one !== undefined ? `Added ${one.name}.` : `Added ${plural(added.length, 'location', 'locations')}.`;
      // The form starts over only once nothing is left in it; rows still to add keep their lines.
      if (await finish(text) && finished) setAdded((n) => n + 1);
    },
    placeSearch: search === 'on',
    limitLine: `${org.name} has 25 locations, the most an organization can have.`,
    orgName: org.name,
    locationCount: locations.length,
  };

  const close = (): void => { setActing(null); };
  const dialog = acting === null ? null : { org, location: acting.location, settle, onDone, onClose: close };

  return (
    <Section kicker="Staff setup" title="Set up before anyone joins">
      <Stack gap={20}>
        <Small>{`Nobody has joined ${org.name} yet. You can add its locations and upload their daily totals so its first admin finds a ready page. Use this only with ${org.name}’s consent. Each change is listed in ${org.name}’s Townwise staff activity, and setup closes for good when the first person joins.`}</Small>
        {done === null ? null : <Messages live="status" takesFocus items={[done]} />}
        {locations.length === 0 ? null : <SetupTable locations={locations} onAct={(verb, location) => { setDone(null); setActing({ verb, location }); }} />}
        <Stack gap={12}>
          <Heading level={3}>Add a location</Heading>
          {/* P10's column, so the search, its list and the checked places line up as an org admin sees them. */}
          <Columns
            main={search === 'checking'
              ? <LoadingLine text="Checking for the Google Maps search…" />
              : <AddLocationForm key={added} target={target} />}
          />
        </Stack>
        <SetupUpload org={org} locations={locations} settled={settle} onSaved={onChanged} />
      </Stack>
      {dialog === null || acting === null ? null
        : acting.verb === 'rename' ? <RenameDialog {...dialog} placeSearch={search === 'on'} />
          : acting.verb === 'deleteSales' ? <DeleteSalesDialog {...dialog} />
            : <DeleteLocationDialog {...dialog} />}
    </Section>
  );
}
