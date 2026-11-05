import { PortalProvider } from '../../../src/portal/PortalProvider';
import { PortalGate } from '../../../src/portal/shell/PortalGate';

// Every signed-in screen. GET /api/me decides where the person may be (spec 4.3, src/portal/routing.ts); the
// groups below hold the frames: (access) the gate pages, (client) the client app, (account) two-step settings,
// and (console) the staff console.
export default function PortalLayout(): React.JSX.Element {
  return (
    <PortalProvider>
      <PortalGate />
    </PortalProvider>
  );
}
