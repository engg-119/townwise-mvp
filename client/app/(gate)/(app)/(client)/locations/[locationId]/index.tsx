import { Forecast } from '../../../../../../src/portal/locations/Forecast';

// P11 Forecast (/locations/[locationId], members; the default tab): docs/portal/spec.md 16.3 and 14. Rendered
// inside the location layout, which draws the header, the switcher and the tabs.
export default function ForecastTab(): React.JSX.Element {
  return <Forecast />;
}
