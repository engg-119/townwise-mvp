import { DataPage } from '../../../../../../src/portal/data/DataPage';

// P26 Your data (/locations/[locationId]/data, members): everything a location's team uploaded or added, with Turn
// off, the downloads and the deletes. docs/portal/spec.md 16.3 and D28. Rendered inside the location layout.
export default function Data(): React.JSX.Element {
  return <DataPage />;
}
