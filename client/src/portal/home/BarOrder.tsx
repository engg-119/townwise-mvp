import { useCallback } from 'react';

import { lateWeekLine, type lateWeekShare } from '../analytics/week';
import { listText, type Metric } from '../analytics/words';
import { plural } from '../format';
import { useLoad } from '../hooks';
import { fetchOrderBoard, type OrderBoard } from '../orders/api';
import { itemsToOrder } from '../orders/words';
import { usePortal } from '../PortalProvider';
import { locationHref } from '../routing';
import { LinkButton } from '../ui/Button';
import { Small } from '../ui/text';
import { Block } from './Block';

// Bar order (home.md 2.3; design Decision 10): the location's own board (GET .../orders, never the sample), read on
// its own so Home never waits for it or fails with it. With a board, how many items the next orders hold above 0 and
// the soonest order's deadline, linked to Orders; with no setup, what is missing, linked to Ordering setup. Its one
// history figure stays: last year's same week, Thursday to Sunday's share, only when all four days have data.

export interface BarOrderWords {
  title: string;
  lines: string[];
  /** False with no setup: the card links to Ordering setup instead of Orders. */
  setUp: boolean;
}

/** The card's words for the board's answer. */
export function barOrderWords(board: OrderBoard): BarOrderWords {
  if (!board.available) {
    const needs = board.missing.length === 0 ? board.reason : `Townwise still needs ${listText(board.missing)} to build an order.`;
    return { title: 'Ordering isn’t set up yet', lines: [needs], setUp: false };
  }
  const lines: string[] = [];
  const [first] = board.orders;
  if (first !== undefined) lines.push(`${first.supplier}: ${first.deadline}`);
  if (board.orders.length > 1) lines.push(`The soonest of ${String(board.orders.length)} orders, one per supplier.`);
  if (board.missing.length > 0) lines.push(`Townwise still can’t see ${listText(board.missing)}.`);
  return { title: `${plural(itemsToOrder(board), 'item', 'items')} to order`, lines, setUp: true };
}

export function BarOrder(props: { share: ReturnType<typeof lateWeekShare>; metric: Metric; locationId: string }): React.JSX.Element {
  const { api } = usePortal();
  const { locationId } = props;
  const { state } = useLoad(useCallback(() => fetchOrderBoard(api, locationId), [api, locationId]));
  const words = state.status === 'ready' ? barOrderWords(state.data) : null;
  return (
    <Block label="Bar order" eyebrow="Bar order" {...(words === null ? {} : { title: words.title })}>
      {state.status === 'loading' ? <Small>Checking the next order.</Small> : null}
      {state.status === 'failed' ? <Small>Townwise couldn’t check the next order.</Small> : null}
      {words?.lines.map((line, index) => <Small key={line} white={index === 0}>{line}</Small>)}
      {props.share === null ? null : <Small white>{lateWeekLine(props.share, props.metric)}</Small>}
      {words?.setUp === false
        ? <LinkButton href={locationHref(locationId, 'ordersSetup')} label="Set up ordering" />
        : <LinkButton href={locationHref(locationId, 'orders')} label="Open Orders" />}
    </Block>
  );
}
