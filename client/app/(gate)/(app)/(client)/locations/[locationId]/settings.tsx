import { LocationSettings } from '../../../../../../src/portal/locations/LocationSettings';

// P16 Location settings (/locations/[locationId]/settings, org admins): docs/portal/spec.md 16.3.
export default function LocationSettingsTab(): React.JSX.Element {
  return <LocationSettings />;
}
