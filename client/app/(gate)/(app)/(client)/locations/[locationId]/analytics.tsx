import { Analytics } from '../../../../../../src/portal/analytics/Analytics';

// P24 Analytics (/locations/[locationId]/analytics, members): docs/portal/spec.md 16.3. The page lives in
// src/portal/analytics/; it reads and writes nothing of its own, so view-as shows it unchanged.
export default function AnalyticsTab(): React.JSX.Element {
  return <Analytics />;
}
