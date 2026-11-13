import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { sendAccessRequest, type AccessRequestInput } from '../../../../src/portal/api';
import { hasCode } from '../../../../src/portal/errors';
import { NumberedList, personEmail, SideHeading, SignedInLine } from '../../../../src/portal/gate';
import { useAction, useBreakpoint } from '../../../../src/portal/hooks';
import { locationCountFor } from '../../../../src/portal/onboarding/checklist';
import { PlaceChecklist } from '../../../../src/portal/onboarding/PlaceChecklist';
import { sendAccessRequestAt, townInputOf, type UsablePlace } from '../../../../src/portal/onboarding/places';
import { usePlaceChecklist } from '../../../../src/portal/onboarding/usePlaceChecklist';
import { usePlaceSearchAvailability } from '../../../../src/portal/onboarding/usePlaceSearch';
import { usePortal, useReadOnly } from '../../../../src/portal/PortalProvider';
import { Page } from '../../../../src/portal/shell/Page';
import type { Access } from '../../../../src/portal/schemas';
import { webAria } from '../../../../src/portal/ui/aria';
import { Actions, Button } from '../../../../src/portal/ui/Button';
import { ErrorNotice, LoadingLine, ReadOnlyLine } from '../../../../src/portal/ui/feedback';
import { FormField } from '../../../../src/portal/ui/FormField';
import { Columns, Pair, Panel, Stack } from '../../../../src/portal/ui/layout';
import { Eyebrow, Heading } from '../../../../src/portal/ui/text';
import { checkTown, EMPTY_TOWN, TOWN_COPY, TownFields, townValueOf, type TownMessages, type TownValue } from '../../../../src/portal/ui/TownFields';
import { theme } from '../../../../src/theme';

// P3. Request access (spec 16.2, F2; the RequestAccess board). For no_org, and by choice from rejected and
// removed. The form renders at once (the town list ships with the app); POST /api/access-requests answers the new
// access (pending), and the portal layout opens Waiting. While the Google Places search is on (the API is asked once,
// onboarding/places.ts checkPlaceSearch), one screen holds two steps of the onboarding's three: Step 1 “Find your
// restaurants” is the places checklist with its map (onboarding/usePlaceChecklist.ts), and Step 2 “About you” is the
// form under it, with the checked places in place of Town (the first one's town is the request's town), and the
// request carries each place with its kind (`places`). Organization name shows the first checked business's name
// until the person types in it; a street address never fills it. Number of locations follows the checked count live,
// never below the number the person typed, and a typed number below the checked count is refused. Send with nothing
// checked says to check a place or enter the town, and waits while a place is loading. “Can’t find it? Enter your
// town yourself” hides the checklist and shows Town, and the places stay checked for Search Google Maps instead. With
// the search off, under view-as, after a search 503 and for a rejected request (its answers are filled in), the form
// is as it was without the checklist. Focus: “Can’t find it?” moves it to Town, and Search Google Maps instead to the
// search field (places/focus.ts).

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
  /** Nothing checked while the checklist shows. */
  places?: string;
}

function tooFew(count: number): string {
  return `You checked ${String(count)} places, so enter at least ${String(count)}.`;
}

const REQUEST_COPY = {
  orgName: 'Enter your organization’s name.',
  contactName: 'Enter your name.',
  contactRole: 'Enter your role.',
  locationCount: 'Enter a whole number from 1 to 50.',
  places: 'Check your restaurant above, or enter your town yourself.',
} as const;

const BLANK: Form = { orgName: '', contactName: '', contactRole: '', town: EMPTY_TOWN, locationCount: '', note: '' };

const PLACE_UNAVAILABLE = 'Google Maps isn’t answering right now, so you can enter your restaurant yourself.';

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

/**
 * The request body, or the field messages that stop it (the API's limits: api/src/handlers/requests.ts). By hand
 * (`manual`) the town is Town's; with the checklist it is the first checked place's, and nothing checked stops it.
 */
function checkRequest(form: Form, places: readonly UsablePlace[], manual: boolean): { input: AccessRequestInput } | { messages: Messages } {
  const messages: Messages = {};
  const orgName = form.orgName.trim();
  const contactName = form.contactName.trim();
  const contactRole = form.contactRole.trim();
  const count = form.locationCount.trim();
  if (orgName.length < 2) messages.orgName = REQUEST_COPY.orgName;
  if (contactName === '') messages.contactName = REQUEST_COPY.contactName;
  if (contactRole === '') messages.contactRole = REQUEST_COPY.contactRole;
  const [first] = places;
  const town = manual ? checkTown(form.town) : first === undefined ? null : { input: townInputOf(first.town) };
  if (town === null) messages.places = REQUEST_COPY.places;
  else if ('messages' in town) messages.town = town.messages;
  const locationCount = Number(count);
  if (!/^\d+$/.test(count) || locationCount < 1 || locationCount > 50) messages.locationCount = REQUEST_COPY.locationCount;
  else if (locationCount < places.length) messages.locationCount = tooFew(places.length);
  if (Object.keys(messages).length > 0 || town === null || !('input' in town)) return { messages };
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
  const search = usePlaceSearchAvailability(api, { readOnly });
  const checklist = usePlaceChecklist(api, PLACE_UNAVAILABLE);
  // A rejected request's count is the floor until the person types another.
  const [typed, setTyped] = useState(() => initialForm(me.access).locationCount);
  // A rejected request's name is the person's own answer, so a checked place never replaces it.
  const [orgTouched, setOrgTouched] = useState(() => initialForm(me.access).orgName !== '');
  /** By hand (true) or with the checklist (false), once the person or a search 503 chose; null before. */
  const [chosen, setManual] = useState<boolean | null>(null);
  const [placeLine, setPlaceLine] = useState<string | null>(null);
  const manual = chosen ?? !(search === 'on' && me.access.state !== 'rejected');
  const email = personEmail(me);
  const readOnlyId = 'request-ro';
  const ro = readOnly ? { readOnly: true, readOnlyId } : {};

  const send = useAction(useCallback(async (input: AccessRequestInput, places: readonly UsablePlace[]) => {
    try {
      applyMe(await (places.length === 0 ? sendAccessRequest(api, input) : sendAccessRequestAt(api, input, places)));
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

  const places: readonly UsablePlace[] = manual ? [] : checklist.places;
  // Number of locations follows the checked count as it changes (and goes back to the typed number with none).
  const [countedFor, setCountedFor] = useState(places.length);
  if (countedFor !== places.length) {
    setCountedFor(places.length);
    setForm((current) => ({ ...current, locationCount: locationCountFor(typed, places.length) }));
  }
  const firstBusiness = places.find((place) => place.kind === 'business');
  const orgName = orgTouched || firstBusiness === undefined ? form.orgName : firstBusiness.name.slice(0, 120);

  const onUnavailable = useCallback((): void => {
    setPlaceLine(PLACE_UNAVAILABLE);
    setManual(true);
  }, []);

  function submit(): void {
    if (readOnly) return;
    const checked = checkRequest({ ...form, orgName }, places, manual);
    if ('messages' in checked) {
      setMessages(checked.messages);
      return;
    }
    setMessages({});
    send.run(checked.input, places);
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
          'We’ll email you when you’re approved.',
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
              <Text style={styles.panelBody}>{`You don’t need to request access. Ask an admin on that team to add ${email}, then reload this page.`}</Text>
            </Panel>
            {search === 'checking' ? <LoadingLine text="Checking for the Google Maps search…" /> : null}
            {search === 'checking' ? null : (
              <Stack gap={20}>
                {manual ? null : (
                  <Stack gap={20}>
                    <StepHeader step={1} title="Find your restaurants" />
                    <PlaceChecklist
                      state={checklist}
                      autoFocus={chosen === false}
                      label="Search for your restaurant or bar"
                      helper="Type its name or street address. Google Maps suggests places in the US."
                      onUnavailable={onUnavailable}
                    />
                    {messages.places === undefined || places.length > 0 ? null : <ErrorNotice message={messages.places} />}
                    <Actions>
                      <Button
                        variant="link"
                        label="Can’t find it? Enter your town yourself"
                        onPress={() => { setPlaceLine(null); setManual(true); }}
                      />
                    </Actions>
                    <StepHeader step={2} title="About you" />
                  </Stack>
                )}
                {placeLine === null ? null : <ErrorNotice message={placeLine} />}
                <ReadOnlyLine text={line} nativeID={readOnlyId} />
                <FormField
                  label="Organization name"
                  helper="Your restaurant or group, as you’d like it to appear in Townwise."
                  value={orgName}
                  onChangeText={(text) => { setOrgTouched(true); update({ orgName: text }); }}
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
                {/* Town beside Number of locations where two fields fit, as on the board; Another town's two fields stay under Town. */}
                <Pair>
                  {manual ? (
                    <TownFields
                      value={form.town}
                      onChange={(town) => { update({ town }); }}
                      {...(messages.town === undefined ? {} : { messages: messages.town })}
                      autoFocus={chosen === true && placeLine === null}
                      {...ro}
                    />
                  ) : null}
                  <FormField
                    label="Number of locations"
                    value={form.locationCount}
                    onChangeText={(locationCount) => { setTyped(locationCount); update({ locationCount }); }}
                    keyboardType="number-pad"
                    inputMode="numeric"
                    numeric
                    maxLength={2}
                    messages={list(messages.locationCount)}
                    {...ro}
                  />
                </Pair>
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
                    disabled={readOnly || send.pending || (!manual && checklist.loading)}
                    {...(readOnly ? { describedBy: readOnlyId } : {})}
                    onPress={submit}
                  />
                  {manual && search === 'on' && placeLine === null
                    ? <Button variant="link" label="Search Google Maps instead" onPress={() => { setManual(false); }} />
                    : null}
                </Actions>
              </Stack>
            )}
            <SignedInLine />
          </Stack>
        )}
      />
    </Page>
  );
}

/** “Step N of 3” over the step's heading: the onboarding's three steps, the third after approval (Home). */
function StepHeader(props: { step: 1 | 2; title: string }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View style={styles.step}>
      <Eyebrow>{`Step ${String(props.step)} of 3`}</Eyebrow>
      <Text role="heading" {...webAria({ 'aria-level': 2 })} style={[phone ? theme.type.h3Phone : theme.type.h3, styles.heading]}>
        {props.title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  step: { gap: theme.space[2] },
  heading: { color: theme.color.white },
  // The board's panel body: `small`, `text2`, at every width.
  panelBody: { ...theme.type.small, color: theme.color.text2 },
});
