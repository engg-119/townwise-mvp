import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useLoad } from '../hooks';
import { LoadFailure, Loading } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { DataTable, type Row } from '../ui/DataTable';
import { ErrorNotice, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Small } from '../ui/text';
import { dayInOrder, REORDER_OVERVIEW, orderCoverSentence } from '../home/beside';
import { fetchOrderBoard, saveOrderDecision, saveOrderRule, turnOffOrderRule, type OrderBoard, type OrderLine } from './api';

// Orders (/locations/[id]/orders). The live board is empty until item sales, a count, and a supplier schedule
// exist. Preview asks the server for the labeled sample. Nothing on a sample can be saved, and nothing is sent
// to a distributor.

const COLUMNS = [
  { key: 'item', label: 'Item', flex: 2 },
  { key: 'order', label: 'Order', numeric: true },
  { key: 'other', label: 'Other deal', numeric: true },
  { key: 'why', label: 'Why', flex: 3 },
];

function quantity(line: OrderLine): string {
  return `${String(line.recommended)} ${line.unit}`;
}

function otherDeal(line: OrderLine): string {
  return line.alternative === null ? '—' : `${String(line.alternative)} ${line.unit}`;
}

function rows(lines: readonly OrderLine[], locationId: string, delivery: string): Row[] {
  return lines.map((line) => ({
    key: line.itemId,
    cells: {
      item: line.neverRunOut ? `${line.name} · Never run out` : line.name,
      order: quantity(line),
      other: otherDeal(line),
      why: (
        <View style={styles.why}>
          <Small>{line.sample ? `Sample. ${line.why}` : line.why}</Small>
          <LinkButton
            href={`${locationHref(locationId, 'agent')}?order=${delivery}&item=${encodeURIComponent(line.itemId)}`}
            label={`Ask why ${line.name}`}
          />
        </View>
      ),
    },
  }));
}

function suppliers(lines: readonly OrderLine[]): string[] {
  const names: string[] = [];
  for (const line of lines) if (!names.includes(line.supplier)) names.push(line.supplier);
  return names;
}

export function Orders(): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const { readOnly, line: readOnlyLine } = useReadOnly();
  const [preview, setPreview] = useState(false);
  const load = useCallback(
    () => fetchOrderBoard(api, location.id, preview),
    [api, location.id, preview],
  );
  const board = useLoad(load);
  const params = useLocalSearchParams<{ day?: string | string[] }>();
  const rawDay = Array.isArray(params.day) ? params.day[0] : params.day;
  const day = typeof rawDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDay) ? rawDay : null;
  if (board.state.status === 'loading') return <Loading text={`Loading orders for ${location.name}`} />;
  if (board.state.status === 'failed') return <LoadFailure error={board.state.error} onRetry={board.reload} />;
  return (
    <View style={styles.page}>
      {readOnly ? <ReadOnlyLine text={readOnlyLine} nativeID="orders-ro" /> : null}
      {day === null ? null : <DayReason day={day} data={board.state.data} />}
      <Board
        data={board.state.data}
        locationId={location.id}
        locationName={location.name}
        preview={preview}
        readOnly={readOnly}
        readOnlyId={readOnly ? 'orders-ro' : null}
        onPreview={() => { setPreview(true); }}
        onSaved={board.reload}
      />
    </View>
  );
}

function DayReason(props: { day: string; data: OrderBoard }): React.JSX.Element {
  const order = props.data.available ? props.data : null;
  return (
    <View style={styles.stack}>
      <Small>{REORDER_OVERVIEW}</Small>
      <Small white>{orderCoverSentence(props.day, order)}</Small>
      {order !== null && dayInOrder(props.day, order) ? (
        <Small>Each line below is that order, with why it came out that way.</Small>
      ) : null}
    </View>
  );
}

function Board(props: {
  data: OrderBoard;
  locationId: string;
  locationName: string;
  preview: boolean;
  readOnly: boolean;
  readOnlyId: string | null;
  onPreview: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const { data } = props;
  if (!data.available) {
    return (
      <View style={styles.stack}>
        <Small>{data.reason}</Small>
        <Actions>
          <Button variant="primary" label="Preview with a sample bar" onPress={props.onPreview} />
        </Actions>
      </View>
    );
  }
  return (
    <View style={styles.stack}>
      <Small>{data.deadline}</Small>
      {data.sample ? (
        <Small>Sample bar. These lines are not {props.locationName}’s stock, and nothing here can be saved.</Small>
      ) : null}
      {data.missing.length > 0 ? <Small>Townwise still can’t see {data.missing.join(', ')}.</Small> : null}
      <Actions>
        <LinkButton href={`${locationHref(props.locationId, 'agent')}?order=${data.delivery}`} label="Explain this order" variant="outline" />
        {props.preview ? null : <Button variant="outline" label="Preview with a sample bar" onPress={props.onPreview} />}
      </Actions>
      {suppliers(data.lines).map((supplier) => (
        <View key={supplier} style={styles.stack}>
          <Small>{supplier}</Small>
          <DataTable
            label={`${supplier} order`}
            columns={COLUMNS}
            rows={rows(data.lines.filter((line) => line.supplier === supplier), props.locationId, data.delivery)}
          />
          {data.sample ? null : data.lines.filter((line) => line.supplier === supplier).map((line) => (
            <LineEditor
              key={line.itemId}
              line={line}
              delivery={data.delivery}
              locationId={props.locationId}
              readOnly={props.readOnly}
              readOnlyId={props.readOnlyId}
              onSaved={props.onSaved}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function LineEditor(props: {
  line: OrderLine;
  delivery: string;
  locationId: string;
  readOnly: boolean;
  readOnlyId: string | null;
  onSaved: () => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const [quantity, setQuantity] = useState(String(props.line.edit?.quantity ?? props.line.recommended));
  const [reason, setReason] = useState(props.line.edit?.reason ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const locked = props.readOnly || pending;
  const field = props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId };

  async function run(work: () => Promise<unknown>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await work();
      props.onSaved();
    } catch {
      setError('That didn’t save. Try again.');
    } finally {
      setPending(false);
    }
  }

  const rule = props.line.rule;
  return (
    <View style={styles.stack}>
      <FormField label={`Quantity for ${props.line.name}`} numeric value={quantity} onChangeText={setQuantity} readOnly={props.readOnly} {...field} />
      <FormField label="Why" value={reason} onChangeText={setReason} readOnly={props.readOnly} {...field} />
      {error === null ? null : <ErrorNotice message={error} />}
      <Actions>
        <Button
          variant="primary"
          label="Save this line"
          disabled={locked}
          onPress={() => {
            void run(() => saveOrderDecision(api, props.locationId, {
              itemId: props.line.itemId, delivery: props.delivery, quantity: Number(quantity), reason,
            }));
          }}
        />
        {props.line.edit === null || rule !== null ? null : (
          <Button
            variant="outline"
            label="Remember this"
            disabled={locked}
            onPress={() => { void run(() => saveOrderRule(api, props.locationId, { itemId: props.line.itemId, situation: props.line.edit?.reason ?? reason })); }}
          />
        )}
        {rule === null ? null : (
          <Button variant="outline" label="Turn this rule off" disabled={locked} onPress={() => { void run(() => turnOffOrderRule(api, props.locationId, rule.id)); }} />
        )}
      </Actions>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { gap: theme.space[4] },
  stack: { gap: theme.space[3] },
  why: { gap: theme.space[2] },
});
