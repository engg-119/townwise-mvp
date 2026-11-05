import { useCallback, useState } from 'react';
import { useRouter } from 'expo-router';

import { createLocation, type TownInput } from './api';
import { CONTACT_EMAIL } from './contact';
import { hasCode } from './errors';
import { useAction } from './hooks';
import { usePortal, useReadOnly } from './PortalProvider';
import { locationHref } from './routing';
import { Actions, Button } from './ui/Button';
import { ErrorNotice, ReadOnlyLine } from './ui/feedback';
import { FormField } from './ui/FormField';
import { Stack } from './ui/layout';
import { checkTown, EMPTY_TOWN, TOWN_COPY, TownFields, type TownMessages, type TownValue } from './ui/TownFields';

// The Add location form (spec P10; inline on Locations when an org admin has none yet, P9): Name and Town, with
// the primary “Add location”. POST /api/org/locations; on success the organization reloads and the new
// location's Forecast tab opens.

export const LOCATION_COPY = {
  name: 'Enter the location’s name.',
  taken: 'Another location already uses that name.',
  limit: `You’ve reached 25 locations. Write to ${CONTACT_EMAIL} for more.`,
} as const;

interface Messages { name?: string; town?: TownMessages }

export function AddLocationForm(): React.JSX.Element {
  const { api, reloadOrg } = usePortal();
  const router = useRouter();
  const { readOnly, line } = useReadOnly();
  const [name, setName] = useState('');
  const [town, setTown] = useState<TownValue>(EMPTY_TOWN);
  const [messages, setMessages] = useState<Messages>({});
  const [limit, setLimit] = useState(false);
  const readOnlyId = 'add-location-ro';
  const ro = readOnly ? { readOnly: true, readOnlyId } : {};

  const add = useAction(useCallback(async (input: { name: string; town: TownInput }) => {
    try {
      const location = await createLocation(api, input);
      reloadOrg();
      router.push(locationHref(location.id));
    } catch (error) {
      if (hasCode(error, 409, 'location_name_taken')) { setMessages({ name: LOCATION_COPY.taken }); return; }
      if (hasCode(error, 409, 'location_limit')) { setLimit(true); return; }
      if (hasCode(error, 400, 'unknown_town')) { setMessages({ town: { choice: TOWN_COPY.choice } }); return; }
      throw error;
    }
  }, [api, reloadOrg, router]));

  function submit(): void {
    if (readOnly) return;
    const trimmed = name.trim();
    const checked = checkTown(town);
    const next: Messages = {};
    if (trimmed === '' || trimmed.length > 80) next.name = LOCATION_COPY.name;
    if ('messages' in checked) next.town = checked.messages;
    setMessages(next);
    setLimit(false);
    if (next.name !== undefined || !('input' in checked)) return;
    add.run({ name: trimmed, town: checked.input });
  }

  return (
    <Stack gap={20}>
      <ReadOnlyLine text={line} nativeID={readOnlyId} />
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
      {limit ? <ErrorNotice message={LOCATION_COPY.limit} /> : null}
      {add.error === null ? null : <ErrorNotice error={add.error} onRetry={submit} />}
      <Actions>
        <Button label="Add location" disabled={readOnly || add.pending} {...(readOnly ? { describedBy: readOnlyId } : {})} onPress={submit} />
      </Actions>
    </Stack>
  );
}
