import { StyleSheet, View } from 'react-native';

import { FormField } from '../ui/FormField';
import { Pair } from '../ui/layout';
import { NOTE_EFFECTS, NOTE_KINDS, type NoteKind } from './api';
import { DateField } from './DateField';
import { DEFAULT_EFFECT, EFFECT_LABEL, KIND_LABEL, WEEKDAYS, type NoteDraft, type NoteMessages } from './noteRules';
import { ToggleGroup } from './parts';

// The fields a note (C6, spec 12) and a business rule's schedule (D31, P28) share: Kind, Starts, Ends (optional),
// Starts at and Ends at (optional hours, hidden for a closure), Only on these days, Effect (defaulted by the kind) and
// Expected guests (hidden when the effect is Closed, except on a private event, where Closed is a buyout and the field
// takes the party's size; on a private event with more guests its helper says Townwise forecasts whole days, so the
// guests count toward each day's total). The note form adds Details and its buttons; the rules page its own. Each
// group's id starts with `idPrefix`, so two forms on one page never share one.

const KIND_OPTIONS = NOTE_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }));
const EFFECT_OPTIONS = NOTE_EFFECTS.map((effect) => ({ value: effect, label: EFFECT_LABEL[effect] }));
/** For a private event, Closed is a buyout. A label of this form's only: the chat's proposal words are unchanged. */
const EVENT_EFFECT_OPTIONS = NOTE_EFFECTS.map((effect) => ({
  value: effect, label: effect === 'closed' ? 'Buyout, closed to walk-ins all day' : EFFECT_LABEL[effect],
}));
const HOURS_HELP = '24-hour, like 18:30. Leave empty for all day.';
/** Forecasts are daily (spec 12): shown where a private event's guests change the forecast. */
function guestsHelp(noun: 'note' | 'rule'): string {
  return `Townwise forecasts whole days, so these guests add to the whole day’s total, on each day the ${noun} covers.`;
}

function effectOptions(kind: NoteKind): typeof EFFECT_OPTIONS {
  return kind === 'private_event' ? EVENT_EFFECT_OPTIONS : EFFECT_OPTIONS;
}
const DAY_OPTIONS = WEEKDAYS.map((day) => ({ value: day.value, label: day.short, accessibilityLabel: day.plural.slice(0, -1) }));

function list(message: string | undefined): readonly string[] {
  return message === undefined ? [] : [message];
}

export function NoteFields(props: {
  draft: NoteDraft;
  set: (patch: Partial<NoteDraft>) => void;
  messages: NoteMessages;
  /** Starts each group's id ('note' on the note form). */
  idPrefix: string;
  /** The end date's helper: one day for a note, no end for a rule's schedule. */
  endHelper: string;
  /** What the fields belong to, in the guests' helper. */
  noun: 'note' | 'rule';
}): React.JSX.Element {
  const { draft, set, messages, idPrefix } = props;
  const buyout = draft.kind === 'private_event' && draft.effect === 'closed';
  return (
    <>
      <ToggleGroup
        label="Kind"
        options={KIND_OPTIONS}
        isPressed={(kind) => draft.kind === kind}
        onPress={(kind) => { set({ kind, effect: DEFAULT_EFFECT[kind] }); }}
      />
      <Pair>
        <DateField label="Starts" value={draft.startDate} onChange={(startDate) => { set({ startDate }); }} messages={list(messages.startDate)} />
        <DateField
          label="Ends (optional)"
          helper={props.endHelper}
          value={draft.endDate}
          onChange={(endDate) => { set({ endDate }); }}
          messages={list(messages.endDate)}
        />
      </Pair>
      {draft.kind === 'closure' ? null : (
        <Pair>
          <TimeField label="Starts at" helper={HOURS_HELP} value={draft.startTime} onChange={(startTime) => { set({ startTime }); }} messages={list(messages.startTime)} />
          <TimeField label="Ends at" value={draft.endTime} onChange={(endTime) => { set({ endTime }); }} messages={list(messages.endTime)} />
        </Pair>
      )}
      <ToggleGroup
        label="Only on these days"
        helper="Leave them all off for every day from start to end. For example, closed on Mondays in March."
        nativeID={`${idPrefix}-days`}
        options={DAY_OPTIONS}
        isPressed={(day) => draft.weekdays.includes(day)}
        onPress={(day) => {
          set({ weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter((other) => other !== day) : [...draft.weekdays, day] });
        }}
      />
      <ToggleGroup
        label="Effect"
        helper="Set from the kind. Change it if you expect something else."
        nativeID={`${idPrefix}-effect`}
        options={effectOptions(draft.kind)}
        isPressed={(effect) => draft.effect === effect}
        onPress={(effect) => { set({ effect }); }}
      />
      {draft.effect === 'closed' && !buyout ? null : (
        <View style={styles.guests}>
          <FormField
            label={buyout ? 'Guests at the buyout (optional)' : 'Expected guests (optional)'}
            value={draft.expectedGuests}
            onChangeText={(expectedGuests) => { set({ expectedGuests }); }}
            keyboardType="number-pad"
            numeric
            maxLength={6}
            messages={list(messages.expectedGuests)}
            {...(draft.kind === 'private_event' && draft.effect === 'more_guests' ? { helper: guestsHelp(props.noun) } : {})}
          />
        </View>
      )}
    </>
  );
}

/** A local time as 'HH:MM': a typed field with the keyboard that has the colon, as DateField has the dash. */
function TimeField(props: {
  label: string; helper?: string; value: string; onChange: (value: string) => void; messages: readonly string[];
}): React.JSX.Element {
  return (
    <FormField
      label={props.label}
      value={props.value}
      onChangeText={props.onChange}
      placeholder="HH:MM"
      keyboardType="numbers-and-punctuation"
      autoCorrect={false}
      maxLength={5}
      numeric
      messages={props.messages}
      {...(props.helper === undefined ? {} : { helper: props.helper })}
    />
  );
}

const styles = StyleSheet.create({
  guests: { maxWidth: 240 },
});
