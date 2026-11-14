import { Setup } from '../../../../../../../src/portal/orders/Setup';

// P31 Ordering setup (/locations/[locationId]/orders/setup, members): suppliers and their delivery days, the items,
// item sales and counts. Rendered inside the location layout; the Orders tab stays marked.
export default function OrdersSetup(): React.JSX.Element {
  return <Setup />;
}
