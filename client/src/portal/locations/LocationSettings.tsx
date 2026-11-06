import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { LOCATION_COPY } from '../AddLocationForm';
import type { TownInput } from '../api';
import { hasCode } from '../errors';
import { useAction } from '../hooks';
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
import { deleteLocation, updateLocation } from './api';

// P16 Location settings (spec 16.3, org admins; the route guard sends members to Locations): Name and Town with
// “Save changes”, then Delete location, offered only while the location holds no sales day and no note, behind a
// typed-name confirmation. Saving reloads the organization, so the header shows the new name, and the page shows
// “Saved.”; deleting opens Locations with “Deleted {name}.”. A 404 on either write means the location was deleted
// in the meantime: the organization reloads, and the location layout says “This location isn’t available.” with
// the link to Locations (spec 10.9). Under view-as every write is disabled in place.

const READ_ONLY_ID = 'location-settings-ro';
const HAS_DATA = 'Delete this location’s sales data and notes first.';

interface Messages { name?: string; town?: TownMessages }

export function LocationSettings(): React.JSX.Element {
  const { location, org } = useLocation();
  const { api, reloadOrg, showNotice } = usePortal();
  const router = useRouter();
  const { readOnly, line } = useReadOnly();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const ro = readOnly ? { readOnly: true, readOnlyId: READ_ONLY_ID } : {};
  const [name, setName] = useState(location.name);
  const [town, setTown] = useState<TownValue>(() => townValueOf(location.town));
  const [messages, setMessages] = useState<Messages>({});
  const [confirming, setConfirming] = useState(false);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  // The server's answer wins over the organization's counts, which can be a moment old.
  const [hasData, setHasData] = useState(location.coverage.dayCount > 0 || location.notesCount > 0);
  const settingsPath = locationHref(location.id, 'settings');

  const save = useAction(useCallback(async (input: { name: string; town: TownInput }) => {
    try {
      await updateLocation(api, location.id, input);
    } catch (error) {
      if (hasCode(error, 409, 'location_name_taken')) { setMessages({ name: LOCATION_COPY.taken }); return; }
      if (hasCode(error, 400, 'unknown_town')) { setMessages({ town: { choice: TOWN_COPY.choice } }); return; }
      if (hasCode(error, 404, 'not_found')) { reloadOrg(); return; }
      throw error;
    }
    // The organization reloads, so the header shows the new name; the notice shows once this page is back.
    showNotice({ text: 'Saved.' }, settingsPath);
    reloadOrg();
  }, [api, location.id, reloadOrg, showNotice, settingsPath]));

  const remove = useAction(useCallback(async () => {
    try {
      await deleteLocation(api, location.id);
    } catch (error) {
      if (hasCode(error, 409, 'location_has_data')) { setHasData(true); setConfirming(false); return; }
      if (hasCode(error, 404, 'not_found')) { setConfirming(false); reloadOrg(); return; }
      throw error;
    }
    // Locations, or the one location left, whose Home Locations opens.
    showNotice({ text: `Deleted ${location.name}.` }, /^\/(dashboard|locations\/[^/]+)$/);
    reloadOrg();
    router.replace('/dashboard');
  }, [api, location.id, location.name, reloadOrg, router, showNotice]));

  function submit(): void {
    if (readOnly) return;
    const trimmed = name.trim();
    const checked = checkTown(town);
    const next: Messages = {};
    if (trimmed === '' || trimmed.length > 80) next.name = LOCATION_COPY.name;
    if ('messages' in checked) next.town = checked.messages;
    setMessages(next);
    if (next.name !== undefined || !('input' in checked)) return;
    save.run({ name: trimmed, town: checked.input });
  }

  return (
    <View>
      <Section first kicker="Location" title="Name and town">
        <Columns
          main={(
            <Stack gap={20}>
              {readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />}
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
        />
      </Section>
      <Section kicker="Only when it holds no data" title="Delete location">
        <Columns
          main={hasData ? (
            <Stack>
              <Small>{HAS_DATA}</Small>
              <Actions>
                <LinkButton href={locationHref(location.id, 'sales')} label="Sales data" />
                <LinkButton href={locationHref(location.id, 'notes')} label="Notes" />
              </Actions>
            </Stack>
          ) : (
            <Actions>
              {readOnlyId === null
                ? <Button variant="outline" label="Delete location" onPress={() => { setStaleError(remove.error); setConfirming(true); }} />
                : <Button variant="outline" label="Delete location" disabled describedBy={readOnlyId} />}
            </Actions>
          )}
        />
      </Section>
      <ConfirmDialog
        visible={confirming}
        title={`Delete ${location.name}?`}
        body={`This deletes the location from ${org.org.name}. This can’t be undone.`}
        typedName={location.name}
        confirmLabel="Delete location"
        pendingLabel="Deleting…"
        pending={remove.pending}
        error={remove.error === staleError ? null : remove.error}
        onConfirm={() => { remove.run(); }}
        onCancel={() => { setConfirming(false); }}
      />
    </View>
  );
}
