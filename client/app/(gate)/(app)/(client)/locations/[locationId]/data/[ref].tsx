import { ItemPage } from '../../../../../../../src/portal/data/ItemPage';

// P27 One item of Your data (/locations/[locationId]/data/[ref], members): the item's details and downloads, and
// what it holds: an upload's days, and on web a stored file drawn in the browser. docs/portal/spec.md 16.3 and D28.
// Rendered inside the location layout.
export default function DataItem(): React.JSX.Element {
  return <ItemPage />;
}
