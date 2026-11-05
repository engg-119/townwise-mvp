import { SalesData } from '../../../../../../../src/portal/locations/SalesData';

// P12 Sales data (/locations/[locationId]/sales, members): docs/portal/spec.md 16.3 and 10.4. The upload step is
// sales/upload.tsx (P13).
export default function SalesTab(): React.JSX.Element {
  return <SalesData />;
}
