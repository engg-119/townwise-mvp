import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { listText } from '../analytics/words';
import { plural } from '../format';
import { useLoad } from '../hooks';
import { LoadFailure, Loading } from '../locations/parts';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { Notice, ReadOnlyLine } from '../ui/feedback';
import { DataTable, type Row } from '../ui/DataTable';
import { Heading, Small } from '../ui/text';
import { dayInOrder, orderCoverSentence, orderForDay, REORDER_OVERVIEW } from '../home/beside';
import { fetchOrderBoard, type LiveBoard, type OrderBoard, type OrderLine, type SupplierOrder } from './api';
import { CountForm } from './CountForm';
import { LineEditor } from './LineEditor';
import { amount, orderQuantity } from './words';

// P30 Orders (/locations/[id]/orders, members; design Decisions 2, 6 and 10): the location's next order from each
// supplier, soonest order-by first, each with its deadline and a line per item; "Enter a count" one step from the
// board; and links to the Ordering setup. With no setup the page says what is missing. Preview asks the server for
// the labeled sample, on which nothing can be saved and nothing links to TownwiseAI, which explains only the
// location's own board. Nothing is sent to a distributor. Under view-as every write is disabled in place, described
// by the read-only line.

const READ_ONLY_ID = 'orders-ro';

const COLUMNS = [
  { key: 'item', label: 'Item', flex: 2 },
  { key: 'order', label: 'Order', numeric: true },
  { key: 'other', label: 'Other deal', numeric: true },
  { key: 'why', label: 'Why', flex: 3 },
];

/** The Order column: the line's saved change when it has one (its why line then says so), else Townwise's quantity. */
function quantity(line: OrderLine): string {
  return amount(orderQuantity(line), line.unit);
}

function otherDeal(line: OrderLine): string {
  return line.alternative === null ? '—' : `${String(line.alternative)} ${line.unit}`;
}

/** A line's row. A sample line has no Ask why: TownwiseAI explains only the location's own board. */
function rows(order: SupplierOrder, locationId: string): Row[] {
  return order.lines.map((line) => ({
    key: line.itemId,
    cells: {
      item: line.neverRunOut ? `${line.name} · Never run out` : line.name,
      order: quantity(line),
      other: otherDeal(line),
      why: (
        <View style={styles.why}>
          <Small>{line.sample ? `Sample. ${line.why}` : line.why}</Small>
          {line.sample ? null : (
            <LinkButton
              href={`${locationHref(locationId, 'agent')}?order=${order.delivery}&item=${encodeURIComponent(line.itemId)}`}
              label={`Ask why ${line.name}`}
            />
          )}
        </View>
      ),
    },
  }));
}

export function Orders(): React.JSX.Element {
  const { api } = usePortal();
  const { location } = useLocation();
  const { readOnly, line: readOnlyLine } = useReadOnly();
  const [preview, setPreview] = useState(false);
  // Held here, so the line outlives the board's reload after the count.
  const [counted, setCounted] = useState<number | null>(null);
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
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  return (
    <View style={styles.page}>
      {readOnly ? <ReadOnlyLine text={readOnlyLine} nativeID={READ_ONLY_ID} /> : null}
      {day === null ? null : <DayReason day={day} data={board.state.data} />}
      {board.state.data.available ? (
        <Board
          data={board.state.data}
          locationId={location.id}
          locationName={location.name}
          preview={preview}
          readOnly={readOnly}
          readOnlyId={readOnlyId}
          counted={counted}
          onPreview={() => { setPreview(true); }}
          onSaved={() => { setCounted(null); board.reload(); }}
          onCounted={(itemCount) => { setCounted(itemCount); board.reload(); }}
        />
      ) : (
        <View style={styles.stack}>
          <Small>{board.state.data.reason}</Small>
          {board.state.data.missing.length > 0 ? <Small>Townwise still needs {listText(board.state.data.missing)}.</Small> : null}
          <Actions>
            <LinkButton variant="primary" href={locationHref(location.id, 'ordersSetup')} label="Set up ordering" />
            <Button variant="outline" label="Preview with a sample bar" onPress={() => { setPreview(true); }} />
          </Actions>
        </View>
      )}
    </View>
  );
}

function DayReason(props: { day: string; data: OrderBoard }): React.JSX.Element {
  const order = props.data.available ? orderForDay(props.day, props.data) : null;
  return (
    <View style={styles.stack}>
      <Small>{REORDER_OVERVIEW}</Small>
      <Small white>{orderCoverSentence(props.day, order)}</Small>
      {order !== null && dayInOrder(props.day, order) ? (
        <Small>Each line of the {order.supplier} order below is what to order, with why it came out that way.</Small>
      ) : null}
    </View>
  );
}

function Board(props: {
  data: LiveBoard;
  locationId: string;
  locationName: string;
  preview: boolean;
  readOnly: boolean;
  readOnlyId: string | null;
  counted: number | null;
  onPreview: () => void;
  onSaved: () => void;
  onCounted: (itemCount: number) => void;
}): React.JSX.Element {
  const { data, counted } = props;
  const [counting, setCounting] = useState(false);
  const described = props.readOnlyId === null ? {} : { describedBy: props.readOnlyId };
  return (
    <View style={styles.stack}>
      {counted === null ? null : <Notice text={`Saved today’s count for ${plural(counted, 'item', 'items')}.`} />}
      {data.sample ? (
        <Small>Sample bar. These lines are not {props.locationName}’s stock, and nothing here can be saved.</Small>
      ) : null}
      {data.missing.length > 0 ? <Small>Townwise still can’t see {listText(data.missing)}.</Small> : null}
      <Actions>
        {data.sample || counting ? null : (
          <Button variant="outline" label="Enter a count" disabled={props.readOnly} {...described} onPress={() => { setCounting(true); }} />
        )}
        <LinkButton
          variant="outline"
          href={locationHref(props.locationId, 'ordersSetup')}
          label={data.sample ? 'Set up ordering' : 'Edit ordering setup'}
        />
        {props.preview ? null : <Button variant="outline" label="Preview with a sample bar" onPress={props.onPreview} />}
      </Actions>
      {counting && !data.sample ? (
        <CountForm
          orders={data.orders}
          today={data.today}
          locationId={props.locationId}
          readOnly={props.readOnly}
          readOnlyId={props.readOnlyId}
          onCancel={() => { setCounting(false); }}
          onSaved={(itemCount) => { setCounting(false); props.onCounted(itemCount); }}
        />
      ) : null}
      {data.orders.map((order) => (
        <View key={order.supplierId} style={styles.stack}>
          <Heading>{order.supplier}</Heading>
          <Small white>{order.deadline}</Small>
          <DataTable label={`${order.supplier} order`} columns={COLUMNS} rows={rows(order, props.locationId)} />
          {data.sample ? null : (
            <Actions>
              <LinkButton
                href={`${locationHref(props.locationId, 'agent')}?order=${order.delivery}`}
                label={`Explain the ${order.supplier} order`}
                variant="outline"
              />
            </Actions>
          )}
          {data.sample ? null : order.lines.map((line) => (
            <LineEditor
              key={line.itemId}
              line={line}
              delivery={order.delivery}
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

const styles = StyleSheet.create({
  page: { gap: theme.space[4] },
  stack: { gap: theme.space[3] },
  why: { gap: theme.space[2] },
});
