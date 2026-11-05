import { Slot } from 'expo-router';

import { ClientFrame } from '../../../../src/portal/shell/Frame';
import { AccessGuard } from '../../../../src/portal/shell/PortalGate';

// The client app frame (spec 15.2, 15.3): members, org admins, and staff viewing as one of them.
export default function ClientLayout(): React.JSX.Element {
  return (
    <AccessGuard>
      <ClientFrame>
        <Slot />
      </ClientFrame>
    </AccessGuard>
  );
}
