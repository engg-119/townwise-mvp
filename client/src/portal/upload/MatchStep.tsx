import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { ids } from '../ui/aria';
import { Actions, Button, LinkButton } from '../ui/Button';
import { LoadingLine, Messages } from '../ui/feedback';
import { Pair, Stack } from '../ui/layout';
import { Select } from '../ui/Select';
import { Heading, Small } from '../ui/text';
import { ChoiceGroup } from './ChoiceGroup';
import type { ColumnProfile } from './columns';
import { canCheck, columnOptions, COPY, matchMessages } from './copy';
import type { Mapping, RowMode } from './days';
import type { DateOrder } from './values';

// Step 2, Match columns (spec 11.2 step 2, D11). The pickers list header names with the kind of values found,
// never a cell. The one exception is the location column's distinct values, once the person names that column.
// Each message prints under its control, and the disabled “Check the totals” is described by all of them.

export type LocationValuesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; values: string[]; more: boolean };

const ROW_MODES: { value: RowMode; label: string }[] = [
  { value: 'day', label: 'One day (a daily summary)' },
  { value: 'check', label: 'One check or order' },
  { value: 'item', label: 'One item on a check' },
];

const ORDERS: { value: DateOrder; label: string }[] = [
  { value: 'month_first', label: 'Month first (03/04/2025 is March 4, 2025)' },
  { value: 'day_first', label: 'Day first (03/04/2025 is April 3, 2025)' },
];

const NONE = '';
const ID = { row: 'upload-row-msgs', date: 'upload-date-msgs', values: 'upload-values-msgs', location: 'upload-location-msgs' };

function columnOf(value: string): number | null {
  return value === NONE ? null : Number(value);
}

function FieldMessages(props: { id: string; items: readonly string[] }): React.JSX.Element | null {
  return props.items.length === 0 ? null : <Messages nativeID={props.id} items={props.items} />;
}

export function MatchStep(props: {
  columns: readonly ColumnProfile[];
  mapping: Mapping;
  onChange: (mapping: Mapping) => void;
  locationName: string;
  locationValues: LocationValuesState;
  readingLine: string;
  onCheck: () => void;
  onBack: () => void;
  cancelHref: string;
}): React.JSX.Element {
  const { columns, mapping, onChange, locationValues } = props;
  const options = columnOptions(columns);
  const optional = [{ value: NONE, label: COPY.notInFile }, ...options];
  const messages = matchMessages(mapping, props.locationName);
  const ready = canCheck(messages);
  const dateColumn = mapping.date === null ? undefined : columns[mapping.date];
  const proven = dateColumn?.order ?? null;

  const reasons = ids(
    messages.row.length > 0 && ID.row,
    messages.date.length > 0 && ID.date,
    messages.values.length > 0 && ID.values,
    messages.locationValue.length > 0 && ID.location,
  );

  function chooseDate(value: string): void {
    const date = columnOf(value);
    const order = date === null ? null : columns[date]?.order ?? null;
    onChange({ ...mapping, date, dateOrder: order ?? mapping.dateOrder });
  }

  return (
    <Stack gap={theme.space[6]} style={styles.read}>
      <Stack gap={theme.space[2]}>
        <Heading level={3}>Match columns</Heading>
        <Small>{COPY.matchCells}</Small>
      </Stack>
      <ChoiceGroup
        legend={COPY.rowQuestion}
        value={mapping.rowMode}
        choices={ROW_MODES}
        onChange={(rowMode) => { onChange({ ...mapping, rowMode }); }}
        {...(mapping.rowMode === 'check' ? { helper: COPY.addedUp } : {})}
        messages={messages.row}
        messagesId={ID.row}
      />
      <View style={styles.field}>
        <Select
          label="Date"
          value={mapping.date === null ? NONE : String(mapping.date)}
          placeholder="Choose a column"
          items={options}
          onChange={chooseDate}
          helper={COPY.dateHelp}
        />
        <FieldMessages id={ID.date} items={messages.date} />
      </View>
      {dateColumn?.slashDates !== true ? null : proven === null ? (
        <ChoiceGroup
          legend="Date order"
          value={mapping.dateOrder}
          choices={ORDERS}
          onChange={(dateOrder) => { onChange({ ...mapping, dateOrder }); }}
          {...(dateColumn.mixedOrder ? { helper: COPY.orderMixed } : {})}
        />
      ) : (
        // A part above 12 sets the order (spec 11.2): shown, not offered.
        <View style={styles.field}>
          <Text style={styles.label}>Date order</Text>
          <Text style={styles.value}>{ORDERS.find((order) => order.value === proven)?.label}</Text>
          <Small>{COPY.orderSet}</Small>
        </View>
      )}
      <View style={styles.field}>
        <Pair>
          <Select
            label="Guests"
            value={mapping.guests === null ? NONE : String(mapping.guests)}
            items={optional}
            onChange={(value) => { onChange({ ...mapping, guests: columnOf(value) }); }}
          />
          <Select
            label="Net sales"
            value={mapping.netSales === null ? NONE : String(mapping.netSales)}
            items={optional}
            onChange={(value) => { onChange({ ...mapping, netSales: columnOf(value) }); }}
          />
        </Pair>
        <Small>{COPY.valuesHelp}</Small>
        <FieldMessages id={ID.values} items={messages.values} />
      </View>
      <Pair>
        <Select
          label="Location column (optional)"
          value={mapping.location === null ? NONE : String(mapping.location)}
          items={optional}
          onChange={(value) => { onChange({ ...mapping, location: columnOf(value), locationValue: null }); }}
          helper={COPY.locationHelp}
        />
        {mapping.location === null ? <View /> : locationValues.status === 'ready' ? (
          <View style={styles.field}>
            <Select
              label={`Which value is ${props.locationName}?`}
              value={mapping.locationValue ?? NONE}
              placeholder="Choose a value"
              items={locationValues.values.map((value) => ({ value, label: value }))}
              onChange={(value) => { onChange({ ...mapping, locationValue: value === NONE ? null : value }); }}
              helper={locationValues.more ? `${COPY.locationValueHelp} ${COPY.moreValues}` : COPY.locationValueHelp}
            />
            <FieldMessages id={ID.location} items={messages.locationValue} />
          </View>
        ) : (
          <LoadingLine text={props.readingLine} minHeight={44} />
        )}
      </Pair>
      <Actions>
        <Button label={COPY.checkTotals} disabled={!ready} {...(reasons === undefined ? {} : { describedBy: reasons })} onPress={props.onCheck} />
        <Button variant="link" label="Back" onPress={props.onBack} />
        <LinkButton href={props.cancelHref} label="Cancel" />
      </Actions>
    </Stack>
  );
}

const styles = StyleSheet.create({
  read: { maxWidth: 760 },
  field: { gap: theme.space[2] },
  label: { ...theme.type.ui, color: theme.color.white },
  value: { ...theme.type.sub, color: theme.color.text2 },
});
