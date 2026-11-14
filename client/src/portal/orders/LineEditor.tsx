import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { usePortal } from '../PortalProvider';
import { Actions, Button } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Small } from '../ui/text';
import { saveOrderDecision, saveOrderRule, turnOffOrderRule, type OrderLine } from './api';
import { LINE_QUANTITY_RULE, parseLineQuantity, REASON_RULE, ruleLine } from './words';

// One live line's edit (design Decision 6): the owner's quantity and why, saved for this delivery; "Remember this",
// which adds the same change to every later order of the item until it is turned off; and each active rule with its
// own "Turn this rule off". A quantity that is empty or not a whole number is never sent (#68 review N6).

const REASON_MAX = 280;

export function LineEditor(props: {
  line: OrderLine;
  delivery: string;
  locationId: string;
  readOnly: boolean;
  readOnlyId: string | null;
  onSaved: () => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { line } = props;
  const [quantity, setQuantity] = useState(String(line.edit?.quantity ?? line.recommended));
  const [reason, setReason] = useState(line.edit?.reason ?? '');
  const [checks, setChecks] = useState<{ quantity: string[]; reason: string[] }>({ quantity: [], reason: [] });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const locked = props.readOnly || pending;
  const field = props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId };
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };

  async function run(work: () => Promise<unknown>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await work();
      props.onSaved();
    } catch (caught) {
      setError(hasCode(caught, 409, 'rule_off')
        ? 'You turned that rule off. Save this line with a new reason to remember a new one.'
        : 'That didn’t save. Try again.');
    } finally {
      setPending(false);
    }
  }

  function save(): void {
    const parsed = parseLineQuantity(quantity);
    const why = reason.trim();
    setChecks({ quantity: parsed === null ? [LINE_QUANTITY_RULE] : [], reason: why === '' ? [REASON_RULE] : [] });
    if (parsed === null || why === '') return;
    void run(() => saveOrderDecision(api, props.locationId, { itemId: line.itemId, delivery: props.delivery, quantity: parsed, reason: why }));
  }

  const edit = line.edit;
  const remember = edit !== null && edit.quantity !== line.recommended && !line.rules.some((rule) => rule.situation === edit.reason);
  return (
    <View style={styles.stack}>
      <FormField
        label={`Quantity for ${line.name}`}
        numeric
        keyboardType="number-pad"
        value={quantity}
        onChangeText={setQuantity}
        messages={checks.quantity}
        readOnly={props.readOnly}
        {...field}
      />
      <FormField
        label={`Reason for ${line.name}`}
        value={reason}
        onChangeText={setReason}
        maxLength={REASON_MAX}
        messages={checks.reason}
        readOnly={props.readOnly}
        {...field}
      />
      {error === null ? null : <ErrorNotice message={error} />}
      <Actions>
        <Button variant="primary" label="Save this line" disabled={locked} {...described} onPress={save} />
        {remember ? (
          <Button
            variant="outline"
            label="Remember this"
            disabled={locked}
            {...described}
            onPress={() => { void run(() => saveOrderRule(api, props.locationId, { itemId: line.itemId, situation: edit.reason })); }}
          />
        ) : null}
      </Actions>
      {remember ? <Small>Remember this adds the same change to every later order of {line.name}, until you turn it off.</Small> : null}
      {line.rules.map((rule) => (
        <View key={rule.id} style={styles.rule}>
          <Small>{ruleLine(rule, line.unit)}</Small>
          <Actions>
            <Button
              variant="outline"
              label="Turn this rule off"
              accessibilityLabel={`Turn this rule off: ${rule.situation}`}
              disabled={locked}
              {...described}
              onPress={() => { void run(() => turnOffOrderRule(api, props.locationId, rule.id)); }}
            />
          </Actions>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space[3] },
  rule: { gap: theme.space[2] },
});
