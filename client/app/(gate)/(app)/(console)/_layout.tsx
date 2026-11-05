import { Slot } from 'expo-router';

import { ConsoleFrame } from '../../../../src/portal/shell/Frame';
import { AccessGuard } from '../../../../src/portal/shell/PortalGate';

// The staff console frame (spec 15.4), on web only; native shows where to find it.
export default function ConsoleLayout(): React.JSX.Element {
  return (
    <AccessGuard>
      <ConsoleFrame>
        <Slot />
      </ConsoleFrame>
    </AccessGuard>
  );
}
