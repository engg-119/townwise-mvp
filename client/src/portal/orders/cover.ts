import type { OrderLine } from './api';
import { amount, orderQuantity } from './words';

// "Will it last?" on Orders (P30), pure: each line's stock after this order (the count plus what the line orders, the
// owner's saved change when there is one) against the use Townwise expects before the supplier's following delivery
// (`mu`) and that use with Townwise's cushion (`orderUpTo`). These are the numbers the board's quantity came from, so
// the chart never disagrees with the why line. A line has a row only when the engine compared the two itself: a count
// at most 7 days old and item sales for the window (api/src/orders/engine.ts, quantityFor).

/** A count counts for 7 days (spec D35), as in the engine. */
const FRESH_COUNT_DAYS = 7;
const EPSILON = 1e-9;

export type CoverStatus = 'short' | 'thin' | 'covered';

export interface CoverRow {
  readonly itemId: string;
  readonly name: string;
  /** The bar's two parts and its marks, each a share (0 to 1) of the row's own scale: its largest quantity. */
  readonly onHandPart: number;
  readonly orderPart: number;
  readonly usePoint: number;
  /** Null when there is no cushion yet (under 2 past windows) or it adds nothing. */
  readonly cushionPoint: number | null;
  readonly status: CoverStatus;
  /** The same numbers in a sentence, which is what a screen reader gets. */
  readonly text: string;
}

const RANK: Readonly<Record<CoverStatus, number>> = { short: 0, thin: 1, covered: 2 };

/** '8', '7.3'. */
function about(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function rowFor(line: OrderLine): CoverRow | null {
  const { onHand, mu, countAgeDays } = line;
  if (onHand === null || mu === null || countAgeDays === null || countAgeDays > FRESH_COUNT_DAYS) return null;
  const ordered = orderQuantity(line);
  const total = onHand + ordered;
  const cushion = line.orderUpTo !== null && line.orderUpTo > mu + EPSILON ? line.orderUpTo : null;
  const scale = Math.max(total, mu, cushion ?? 0);
  if (scale <= 0) return null;
  const status: CoverStatus = total + EPSILON < mu ? 'short' : cushion !== null && total + EPSILON < cushion ? 'thin' : 'covered';
  const verdict = status === 'short'
    ? 'That is less than the expected use.'
    : status === 'thin'
      ? 'That covers it, with less to spare than Townwise aims for.'
      : cushion === null ? 'That covers the expected use.' : 'That covers it, with the cushion Townwise aims for.';
  return {
    itemId: line.itemId,
    name: line.name,
    onHandPart: onHand / scale,
    orderPart: ordered / scale,
    usePoint: mu / scale,
    cushionPoint: cushion === null ? null : cushion / scale,
    status,
    text: `${amount(onHand, line.unit)} on hand + ${String(ordered)} ordered = ${amount(total, line.unit)}. Expected use: about ${about(mu)}. ${verdict}`,
  };
}

/** A supplier order's rows: the short ones first, then the thin, then the covered, each group in the board's order. */
export function coverRows(order: { readonly lines: readonly OrderLine[] }): CoverRow[] {
  return order.lines
    .map(rowFor)
    .filter((row): row is CoverRow => row !== null)
    .sort((a, b) => RANK[a.status] - RANK[b.status]);
}
