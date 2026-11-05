import { Slot } from 'expo-router';

import { LocationShell } from '../../../../../../src/portal/shell/LocationShell';

// A location's pages (P11 to P16 and the tuning chat): its header, the location switcher and the tabs. Each tab
// page renders only its content; read the location with useLocation().
export default function LocationLayout(): React.JSX.Element {
  return (
    <LocationShell>
      <Slot />
    </LocationShell>
  );
}
