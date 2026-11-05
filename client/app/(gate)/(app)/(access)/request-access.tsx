import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { sendAccessRequest, type AccessRequestInput } from '../../../../src/portal/api';
import { hasCode } from '../../../../src/portal/errors';
import { NumberedList, personEmail, SideHeading, SignedInLine } from '../../../../src/portal/gate';
import { useAction } from '../../../../src/portal/hooks';
import { usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { Page } from '../../../../src/portal/shell/Page';
import type { Access } from '../../../../src/portal/schemas';
import { Actions, Button } from '../../../../src/portal/ui/Button';
import { ErrorNotice, ReadOnlyLine } from '../../../../src/portal/ui/feedback';
import { FormField } from '../../../../src/portal/ui/FormField';
import { Columns, Pair, Panel, Stack } from '../../../../src/portal/ui/layout';
import { Body, Heading } from '../../../../src/portal/ui/text';
import { checkTown, EMPTY_TOWN, TOWN_COPY, TownFields, townValueOf, type TownMessages, type TownValue } from '../../../../src/portal/ui/TownFields';

// P3. Request access (spec 16.2, F2; the RequestAccess board). For no_org, and by choice from rejected and
// removed. The form renders at once (the town list ships with the app); POST /api/access-requests answers the new
// access (pending), and the portal layout opens Waiting.

interface Form {
  orgName: string;
  contactName: string;
  contactRole: string;
  town: TownValue;
  locationCount: string;
  note: string;
}

interface Messages {
  orgName?: string;
  contactName?: string;
  contactRole?: string;
  town?: TownMessages;
  locationCount?: string;
}

const REQUEST_COPY = {
  orgName: 'Enter your organization’s name.',
  contactName: 'Enter your name.',
  contactRole: 'Enter your role.',
  locationCount: 'Enter a whole number from 1 to 50.',
} as const;

const BLANK: Form = { orgName: '', contactName: '', contactRole: '', town: EMPTY_TOWN, locationCount: '', note: '' };

/** For a rejected request, the previous answers are filled in. */
function initialForm(access: Access): Form {
  if (access.state !== 'rejected') return BLANK;
  const { request } = access;
  return {
    orgName: request.orgName,
    contactName: request.contactName,
    contactRole: request.contactRole,
    town: townValueOf(request.town),
    locationCount: String(request.locationCount),
    note: request.note ?? '',
  };
}

/** The request body, or the field messages that stop it (the API's limits: api/src/handlers/requests.ts). */
function checkRequest(form: Form): { input: AccessRequestInput } | { messages: Messages } {
  const messages: Messages = {};
  const orgName = form.orgName.trim();
  const contactName = form.contactName.trim();
  const contactRole = form.contactRole.trim();
  const count = form.locationCount.trim();
  if (orgName.length < 2) messages.orgName = REQUEST_COPY.orgName;
  if (contactName === '') messages.contactName = REQUEST_COPY.contactName;
  if (contactRole === '') messages.contactRole = REQUEST_COPY.contactRole;
  const town = checkTown(form.town);
  if ('messages' in town) messages.town = town.messages;
  const locationCount = Number(count);
  if (!/^\d+$/.test(count) || locationCount < 1 || locationCount > 50) messages.locationCount = REQUEST_COPY.locationCount;
  if (Object.keys(messages).length > 0 || !('input' in town)) return { messages };
  const note = form.note.trim();
  return {
    input: { orgName, contactName, contactRole, town: town.input, locationCount, ...(note === '' ? {} : { note }) },
  };
}

function list(message: string | undefined): readonly string[] {
  return message === undefined ? [] : [message];
}

export default function RequestAccessPage(): React.JSX.Element {
  const { me, api, applyMe, refreshMe } = usePortal();
  const { readOnly, line } = useReadOnly();
  const [form, setForm] = useState<Form>(() => initialForm(me.access));
  const [messages, setMessages] = useState<Messages>({});
  const email = personEmail(me);
  const readOnlyId = 'request-ro';
  const ro = readOnly ? { readOnly: true, readOnlyId } : {};

  const send = useAction(useCallback(async (input: AccessRequestInput) => {
    try {
      applyMe(await sendAccessRequest(api, input));
    } catch (error) {
      // Another tab sent one first: read the access again, which opens Waiting.
      if (hasCode(error, 409, 'request_exists')) {
        await refreshMe();
        return;
      }
      if (hasCode(error, 400, 'unknown_town')) {
        setMessages({ town: { choice: TOWN_COPY.choice } });
        return;
      }
      throw error;
    }
  }, [api, applyMe, refreshMe]));

  function submit(): void {
    if (readOnly) return;
    const checked = checkRequest(form);
    if ('messages' in checked) {
      setMessages(checked.messages);
      return;
    }
    setMessages({});
    send.run(checked.input);
  }

  function update(patch: Partial<Form>): void {
    setForm((current) => ({ ...current, ...patch }));
  }

  const lead = `Townwise is in early access. Tell us about your restaurant or group, and someone on our team will review it by hand.${
    me.access.state === 'removed' ? ' Setting up a different organization? Tell us about it below.' : ''}`;
  const side = (
    <View>
      <SideHeading>What happens next</SideHeading>
      <NumberedList
        items={[
          'Someone on our team reviews your request.',
          'We don’t send email yet. Check back here.',
          'Once you’re approved, you’ll upload your sales history and see your town.',
        ]}
      />
    </View>
  );

  return (
    <Page gate eyebrow="Early access" title="Request access" lead={lead} side={side}>
      <Columns
        main={(
          <Stack gap={20}>
            <Panel>
              <Heading>Joining a team that already uses Townwise?</Heading>
              <Body>{`You don’t need to request access. Ask an admin on that team to add ${email}, then reload this page.`}</Body>
            </Panel>
            <Stack gap={20}>
              <ReadOnlyLine text={line} nativeID={readOnlyId} />
              <FormField
                label="Organization name"
                helper="Your restaurant or group, as you’d like it to appear in Townwise."
                value={form.orgName}
                onChangeText={(orgName) => { update({ orgName }); }}
                autoComplete="organization"
                autoCapitalize="words"
                maxLength={120}
                messages={list(messages.orgName)}
                {...ro}
              />
              <Pair>
                <FormField
                  label="Your name"
                  value={form.contactName}
                  onChangeText={(contactName) => { update({ contactName }); }}
                  autoComplete="name"
                  autoCapitalize="words"
                  maxLength={120}
                  messages={list(messages.contactName)}
                  {...ro}
                />
                <FormField
                  label="Your role"
                  helper="For example, owner or general manager."
                  value={form.contactRole}
                  onChangeText={(contactRole) => { update({ contactRole }); }}
                  autoComplete="organization-title"
                  autoCapitalize="sentences"
                  maxLength={80}
                  messages={list(messages.contactRole)}
                  {...ro}
                />
              </Pair>
              <TownFields
                value={form.town}
                onChange={(town) => { update({ town }); }}
                {...(messages.town === undefined ? {} : { messages: messages.town })}
                {...ro}
              />
              <FormField
                label="Number of locations"
                value={form.locationCount}
                onChangeText={(locationCount) => { update({ locationCount }); }}
                keyboardType="number-pad"
                inputMode="numeric"
                numeric
                maxLength={2}
                messages={list(messages.locationCount)}
                {...ro}
              />
              <FormField
                label="Anything we should know? (optional)"
                helper="Don’t include guest names or sales figures."
                value={form.note}
                onChangeText={(note) => { update({ note }); }}
                multiline
                autoCapitalize="sentences"
                maxLength={1000}
                {...ro}
              />
              {send.error === null ? null : <ErrorNotice error={send.error} onRetry={submit} />}
              <Actions>
                <Button
                  label={send.pending ? 'Sending…' : 'Send request'}
                  disabled={readOnly || send.pending}
                  {...(readOnly ? { describedBy: readOnlyId } : {})}
                  onPress={submit}
                />
              </Actions>
            </Stack>
            <SignedInLine />
          </Stack>
        )}
      />
    </Page>
  );
}
