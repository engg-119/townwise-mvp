import type { TownInput } from '../api';
import type { Town } from '../schemas';
import { ANOTHER_TOWN, TOWN_GROUPS, US_STATE_CODES, US_STATE_OPTIONS } from '../towns';
import { FormField } from './FormField';
import { Pair, Stack } from './layout';
import { Select } from './Select';

// The Town field (spec P3, P10, P16): the twelve towns grouped "College towns" and "Seasonal and event towns",
// then "Another town", which reveals Town name and State (a select of the 50 states and DC, by name). The lists ship
// with the app, so they never load.

export interface TownValue {
  /** '' (none yet), a town id, or ANOTHER_TOWN. */
  choice: string;
  name: string;
  state: string;
}

export const EMPTY_TOWN: TownValue = { choice: '', name: '', state: '' };

export interface TownMessages { choice?: string; name?: string; state?: string }

export const TOWN_COPY = {
  choice: 'Pick a town, or choose Another town.',
  name: 'Enter the town’s name.',
  state: 'Choose a state.',
} as const;

const ITEMS = [...TOWN_GROUPS, { value: ANOTHER_TOWN, label: 'Another town' }];

/** A stored town as the field's value (to prefill a form). */
export function townValueOf(town: Town): TownValue {
  if (town.townId !== null && TOWN_GROUPS.some((group) => group.options.some((option) => option.value === town.townId))) {
    return { choice: town.townId, name: '', state: '' };
  }
  return { choice: ANOTHER_TOWN, name: town.name, state: town.state };
}

/** The API's TownInput, or the field messages that stop the form. */
export function checkTown(value: TownValue): { input: TownInput } | { messages: TownMessages } {
  if (value.choice === '') return { messages: { choice: TOWN_COPY.choice } };
  if (value.choice !== ANOTHER_TOWN) return { input: { townId: value.choice } };
  const name = value.name.trim();
  const state = value.state.trim().toUpperCase();
  const messages: TownMessages = {};
  if (name === '' || name.length > 80) messages.name = TOWN_COPY.name;
  if (!US_STATE_CODES.includes(state)) messages.state = TOWN_COPY.state;
  if (messages.name !== undefined || messages.state !== undefined) return { messages };
  return { input: { townId: null, name, state } };
}

function list(message: string | undefined): readonly string[] {
  return message === undefined ? [] : [message];
}

export function TownFields(props: {
  value: TownValue;
  onChange: (value: TownValue) => void;
  messages?: TownMessages;
  readOnly?: boolean;
  readOnlyId?: string;
}): React.JSX.Element {
  const { value, onChange, messages = {} } = props;
  const readOnly = props.readOnly === true;
  const ro = { readOnly, ...(props.readOnlyId === undefined ? {} : { readOnlyId: props.readOnlyId }) };
  return (
    <Stack gap={20}>
      <Select
        label="Town"
        placeholder="Choose a town"
        items={ITEMS}
        value={value.choice}
        onChange={(choice) => { onChange({ ...value, choice }); }}
        messages={list(messages.choice)}
        {...ro}
      />
      {value.choice === ANOTHER_TOWN ? (
        <Pair>
          <FormField
            label="Town name"
            value={value.name}
            onChangeText={(name) => { onChange({ ...value, name }); }}
            autoCapitalize="words"
            maxLength={80}
            messages={list(messages.name)}
            {...ro}
          />
          <Select
            label="State"
            placeholder="Choose a state"
            items={US_STATE_OPTIONS}
            value={value.state}
            onChange={(state) => { onChange({ ...value, state }); }}
            messages={list(messages.state)}
            {...ro}
          />
        </Pair>
      ) : null}
    </Stack>
  );
}
