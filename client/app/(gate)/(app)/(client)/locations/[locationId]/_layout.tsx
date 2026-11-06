import { Slot } from 'expo-router';

import { LocationShell } from '../../../../../../src/portal/shell/LocationShell';

// A location's pages (P11 to P16, P24 Analytics and P25 TownwiseAI): the layout draws the header (eyebrow, h1 and
// the side links); the sections are in the top bar. Each page renders only its content; read the location with
// useLocation().
export default function LocationLayout(): React.JSX.Element {
  return (
    <LocationShell>
      <Slot />
    </LocationShell>
  );
}
