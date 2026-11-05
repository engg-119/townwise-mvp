import { Slot } from 'expo-router';

import { AccountFrame } from '../../../../src/portal/shell/Frame';
import { AccessGuard } from '../../../../src/portal/shell/PortalGate';

// Two-step settings (P7): the client app frame for members, the gate frame for everyone else, staff in setup
// included.
export default function AccountLayout(): React.JSX.Element {
  return (
    <AccessGuard>
      <AccountFrame>
        <Slot />
      </AccountFrame>
    </AccessGuard>
  );
}
