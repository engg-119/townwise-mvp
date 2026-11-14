import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatDate } from '../format';
import { hasCode } from '../errors';
import { localToday } from '../locations/dates';
import { usePortal } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice, Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Small } from '../ui/text';
import { saveCount, type SupplierOrder } from './api';
import { COUNT_RULE, countItems } from './words';

// "Enter a count" (the order-counts spec): one field per item, grouped by supplier, empty to start. Only the filled
// fields are sent, as today's count on the device's calendar, and an item left empty keeps its last count. A field
// that is not a count (0 to 9,999 in whole or half units) is never sent (#68 review N6).

export function CountForm(props: {
  orders: readonly SupplierOrder[];
  locationId: string;
  readOnly: boolean;
  readOnlyId: string | null;
  onSaved: (itemCount: number) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const [today] = useState(localToday);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const field = props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId };
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };

  async function save(): Promise<void> {
    const { items, invalid: wrong } = countItems(fields);
    const filled = Object.keys(items).length;
    setInvalid(wrong);
    setProblem(wrong.length === 0 && filled === 0 ? 'Enter a count for at least one item.' : null);
    if (wrong.length > 0 || filled === 0) return;
    setPending(true);
    setError(null);
    try {
      await saveCount(api, props.locationId, { date: today, items });
      props.onSaved(filled);
    } catch (caught) {
      setError(hasCode(caught, 400, 'unknown_item')
        ? 'An item is no longer in this location’s ordering setup. Reload the page and count again.'
        : 'That didn’t save. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.stack}>
      <Small>
        Count what is on hand today, {formatDate(today)}, in each item’s unit. Leave an item empty to keep its last count.
      </Small>
      {props.orders.map((order) => (
        <View key={order.supplierId} style={styles.stack}>
          <Small white>{order.supplier}</Small>
          {order.lines.map((line) => (
            <FormField
              key={line.itemId}
              label={`${line.name}, in ${line.unit}`}
              numeric
              keyboardType="decimal-pad"
              value={fields[line.itemId] ?? ''}
              onChangeText={(text) => { setFields((now) => ({ ...now, [line.itemId]: text })); }}
              messages={invalid.includes(line.itemId) ? [COUNT_RULE] : []}
              readOnly={props.readOnly}
              {...field}
            />
          ))}
        </View>
      ))}
      {problem === null ? null : <Messages live="alert" items={[problem]} />}
      {error === null ? null : <ErrorNotice message={error} />}
      <Actions>
        <Button variant="primary" label="Save the count" disabled={props.readOnly || pending} {...described} onPress={() => { void save(); }} />
        <Button variant="outline" label="Cancel" disabled={pending} onPress={props.onCancel} />
      </Actions>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space[3] },
});
