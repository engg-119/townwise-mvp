import { Slot } from 'expo-router';

import { GateFrame } from '../../../../src/portal/shell/Frame';
import { AccessGuard } from '../../../../src/portal/shell/PortalGate';

// The gate frame (spec 15.1): Request access, Waiting, No access and Joining.
export default function AccessLayout(): React.JSX.Element {
  return (
    <AccessGuard>
      <GateFrame>
        <Slot />
      </GateFrame>
    </AccessGuard>
  );
}
