import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { formatDate, plural } from '../format';
import { Actions, Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Messages } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/layout';
import { Select } from '../ui/Select';
import { Small } from '../ui/text';
import type { OrderSetupAnswer } from './api';
import type { ItemMark } from './proposal';
import {
  CATEGORY_OPTIONS, EMPTY_DELIVERY, EMPTY_POS_NAME, fieldId, SETUP_LIMITS, UNIT_OPTIONS, WEEKDAY_OPTIONS, type DeliveryDraft, type ItemDraft,
  type PosNameDraft, type SetupProblems, type SupplierDraft,
} from './setupDraft';
import { amount } from './words';

// One supplier and one item of the Ordering setup page (Setup.tsx): every field of the draft, with the messages its
// last Save found, and, for a stored item, its latest count and whether item sales matched it. A delivery's and a
// point-of-sale name's fields are named with their number ("Delivery day 2"), as their Remove buttons are. Under
// view-as and while a save runs, every field is read-only and every button disabled in place. A TownwiseAI read's mark
// (D41) takes the place of its field's helper, so the field's aria-describedby names it.

export const SERVINGS_HINT = 'How many servings one unit holds: a case of 24 cans is 24; a half-barrel keg is about 124 sixteen-ounce pints.';

export interface RowLock {
  /** View-as, or a save running. */
  readonly locked: boolean;
  /** The read-only line's id under view-as, for the fields to point at. */
  readonly readOnlyId: string | null;
}

function chrome(lock: RowLock, problems: SetupProblems, id: string): { readOnly: boolean; readOnlyId?: string; messages: readonly string[] } {
  return {
    readOnly: lock.locked,
    ...(lock.readOnlyId === null ? {} : { readOnlyId: lock.readOnlyId }),
    messages: problems[id] ?? [],
  };
}

function described(lock: RowLock): { describedBy?: string } {
  return lock.readOnlyId === null ? {} : { describedBy: lock.readOnlyId };
}

export function SupplierPanel(props: {
  supplier: SupplierDraft;
  index: number;
  problems: SetupProblems;
  lock: RowLock;
  onChange: (next: SupplierDraft) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { supplier, problems, lock } = props;
  const set = (patch: Partial<SupplierDraft>): void => { props.onChange({ ...supplier, ...patch }); };
  const setDelivery = (at: number, patch: Partial<DeliveryDraft>): void => {
    set({ deliveries: supplier.deliveries.map((delivery, index) => (index === at ? { ...delivery, ...patch } : delivery)) });
  };
  const deliveryMessages = problems[fieldId.supplier(supplier.key, 'deliveries')] ?? [];
  return (
    <Panel label={`Supplier ${String(props.index + 1)}`}>
      <FormField
        label="Supplier name"
        value={supplier.name}
        onChangeText={(name) => { set({ name }); }}
        {...chrome(lock, problems, fieldId.supplier(supplier.key, 'name'))}
      />
      {supplier.deliveries.map((delivery, at) => (
        <View key={at} style={styles.row}>
          <View style={styles.cell}>
            <Select
              label="Delivery day"
              accessibilityLabel={`Delivery day ${String(at + 1)}`}
              placeholder="Choose a day"
              items={WEEKDAY_OPTIONS}
              value={delivery.deliveryWeekday}
              onChange={(deliveryWeekday) => { setDelivery(at, { deliveryWeekday }); }}
              {...chrome(lock, problems, fieldId.delivery(supplier.key, at, 'delivery'))}
            />
          </View>
          <View style={styles.cell}>
            <Select
              label="Order by day"
              accessibilityLabel={`Order by day ${String(at + 1)}`}
              placeholder="Choose a day"
              items={WEEKDAY_OPTIONS}
              value={delivery.cutoffWeekday}
              onChange={(cutoffWeekday) => { setDelivery(at, { cutoffWeekday }); }}
              {...chrome(lock, problems, fieldId.delivery(supplier.key, at, 'cutoff'))}
            />
          </View>
          <View style={styles.cell}>
            <FormField
              label="Order by time"
              accessibilityLabel={`Order by time ${String(at + 1)}`}
              helper="24 hour, such as 14:00."
              numeric
              value={delivery.cutoffTime}
              onChangeText={(cutoffTime) => { setDelivery(at, { cutoffTime }); }}
              {...chrome(lock, problems, fieldId.delivery(supplier.key, at, 'time'))}
            />
          </View>
          <View style={styles.end}>
            <Button
              variant="link"
              label="Remove"
              accessibilityLabel={`Remove delivery ${String(at + 1)}`}
              disabled={lock.locked}
              {...described(lock)}
              onPress={() => { set({ deliveries: supplier.deliveries.filter((_, index) => index !== at) }); }}
            />
          </View>
        </View>
      ))}
      {deliveryMessages.length === 0 ? null : <Messages items={deliveryMessages} />}
      <Actions>
        <Button
          variant="outline"
          label="Add a delivery"
          disabled={lock.locked || supplier.deliveries.length >= SETUP_LIMITS.deliveries}
          {...described(lock)}
          onPress={() => { set({ deliveries: [...supplier.deliveries, EMPTY_DELIVERY] }); }}
        />
        <Button variant="link" label="Remove this supplier" disabled={lock.locked} {...described(lock)} onPress={props.onRemove} />
      </Actions>
    </Panel>
  );
}

type Status = Pick<OrderSetupAnswer, 'coverage' | 'itemCoverage' | 'counts' | 'itemsWithHistory'>;

/**
 * A stored item with history a removal would leave behind, as the server reads it: item sales the board reads, a count
 * in its 400 days, or a saved edit or rule (GET .../orders/setup `itemsWithHistory`).
 */
export function itemHasHistory(item: ItemDraft, status: Status): boolean {
  return item.id !== null && status.itemsWithHistory.includes(item.id);
}

/** A stored item's latest count, and whether the stored item sales matched it in the last 8 weeks. */
export function itemStatus(item: ItemDraft, status: Status): string[] {
  if (item.id === null) return [];
  const lines: string[] = [];
  const count = status.counts[item.id];
  if (count === undefined) lines.push('No count in the last 400 days.');
  else {
    const counted = item.unit === '' ? String(count.quantity) : amount(count.quantity, item.unit);
    lines.push(`Last count: ${counted} on ${formatDate(count.date)}.`);
  }
  const days = status.itemCoverage[item.id];
  if (status.coverage !== null && days !== undefined) {
    lines.push(days === 0
      ? 'No sales matched in the last 8 weeks. Check its point-of-sale names.'
      : `Sales matched on ${plural(days, 'day', 'days')} in the last 8 weeks.`);
  }
  return lines;
}

export function ItemPanel(props: {
  item: ItemDraft;
  index: number;
  suppliers: readonly SupplierDraft[];
  problems: SetupProblems;
  status: Status;
  /** What a TownwiseAI read marked on this item: an estimated servings value, a name not in the file. */
  mark: ItemMark | undefined;
  lock: RowLock;
  onChange: (next: ItemDraft) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { item, problems, lock, mark } = props;
  const set = (patch: Partial<ItemDraft>): void => { props.onChange({ ...item, ...patch }); };
  const setPos = (at: number, patch: Partial<PosNameDraft>): void => {
    set({ posNames: item.posNames.map((pos, index) => (index === at ? { ...pos, ...patch } : pos)) });
  };
  const field = (name: Parameters<typeof fieldId.item>[1]): ReturnType<typeof chrome> => chrome(lock, problems, fieldId.item(item.key, name));
  const supplierOptions = props.suppliers.map((supplier) => ({ value: supplier.key, label: supplier.name.trim() === '' ? 'Unnamed supplier' : supplier.name.trim() }));
  const posMessages = problems[fieldId.item(item.key, 'posNames')] ?? [];
  const status = itemStatus(item, props.status);
  return (
    <Panel label={`Item ${String(props.index + 1)}`}>
      <View style={styles.row}>
        <View style={styles.wide}>
          <FormField
            label="Item name"
            {...(mark?.name === undefined ? {} : { helper: mark.name.text })}
            value={item.name}
            onChangeText={(name) => { set({ name }); }}
            {...field('name')}
          />
        </View>
        <View style={styles.cell}>
          <Select
            label="Supplier"
            placeholder="Choose a supplier"
            items={supplierOptions}
            value={supplierOptions.some((option) => option.value === item.supplierKey) ? item.supplierKey : ''}
            onChange={(supplierKey) => { set({ supplierKey }); }}
            {...field('supplier')}
          />
        </View>
      </View>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Select
            label="Category"
            placeholder="Choose a category"
            items={CATEGORY_OPTIONS}
            value={item.category}
            onChange={(category) => { set({ category: CATEGORY_OPTIONS.find((option) => option.value === category)?.value ?? '' }); }}
            {...field('category')}
          />
        </View>
        <View style={styles.cell}>
          <Select
            label="Unit"
            placeholder="Choose a unit"
            items={UNIT_OPTIONS}
            value={item.unit}
            onChange={(unit) => { set({ unit: UNIT_OPTIONS.find((option) => option.value === unit)?.value ?? '' }); }}
            {...field('unit')}
          />
        </View>
      </View>
      <View style={styles.row}>
        <View style={styles.wide}>
          <FormField
            label="Servings per unit"
            helper={mark?.servings?.text ?? SERVINGS_HINT}
            numeric
            keyboardType="decimal-pad"
            value={item.servingsPerUnit}
            onChangeText={(servingsPerUnit) => { set({ servingsPerUnit }); }}
            {...field('servings')}
          />
        </View>
        <View style={styles.cell}>
          <FormField
            label="Par"
            helper="The fewest units to have after a delivery."
            numeric
            keyboardType="number-pad"
            value={item.par}
            onChangeText={(par) => { set({ par }); }}
            {...field('par')}
          />
        </View>
        <View style={styles.cell}>
          <FormField
            label="Deal size (optional)"
            helper="Order in multiples of this. Leave it empty for none."
            numeric
            keyboardType="number-pad"
            value={item.dealSize}
            onChangeText={(dealSize) => { set({ dealSize }); }}
            {...field('deal')}
          />
        </View>
      </View>
      <Checkbox
        label="Never run out"
        checked={item.neverRunOut}
        disabled={lock.locked}
        {...described(lock)}
        onChange={(neverRunOut) => { set({ neverRunOut }); }}
      />
      <Small>Point-of-sale names: what your point-of-sale system calls this item. A pitcher that pours four servings has 4 servings per sale.</Small>
      {item.posNames.map((pos, at) => (
        <View key={at} style={styles.row}>
          <View style={styles.wide}>
            <FormField
              label="Point-of-sale name"
              accessibilityLabel={`Point-of-sale name ${String(at + 1)}`}
              value={pos.name}
              onChangeText={(name) => { setPos(at, { name }); }}
              {...chrome(lock, problems, fieldId.pos(item.key, at, 'name'))}
            />
          </View>
          <View style={styles.cell}>
            <FormField
              label="Servings per sale"
              accessibilityLabel={`Servings per sale ${String(at + 1)}`}
              numeric
              keyboardType="decimal-pad"
              value={pos.perSale}
              onChangeText={(perSale) => { setPos(at, { perSale }); }}
              {...chrome(lock, problems, fieldId.pos(item.key, at, 'perSale'))}
            />
          </View>
          <View style={styles.end}>
            <Button
              variant="link"
              label="Remove"
              accessibilityLabel={`Remove point-of-sale name ${String(at + 1)}`}
              disabled={lock.locked}
              {...described(lock)}
              onPress={() => { set({ posNames: item.posNames.filter((_, index) => index !== at) }); }}
            />
          </View>
        </View>
      ))}
      {posMessages.length === 0 ? null : <Messages items={posMessages} />}
      {status.length === 0 ? null : <View style={styles.status}>{status.map((line) => <Small key={line} white>{line}</Small>)}</View>}
      <Actions>
        <Button
          variant="outline"
          label="Add a point-of-sale name"
          disabled={lock.locked || item.posNames.length >= SETUP_LIMITS.posNames}
          {...described(lock)}
          onPress={() => { set({ posNames: [...item.posNames, EMPTY_POS_NAME] }); }}
        />
        <Button variant="link" label="Remove this item" disabled={lock.locked} {...described(lock)} onPress={props.onRemove} />
      </Actions>
    </Panel>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: theme.space[4], rowGap: theme.space[4] },
  cell: { flexGrow: 1, flexBasis: 160, minWidth: 0 },
  wide: { flexGrow: 2, flexBasis: 240, minWidth: 0 },
  end: { paddingTop: 28 },
  status: { gap: theme.space[1] },
});
