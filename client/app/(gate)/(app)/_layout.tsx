import { usePathname } from 'expo-router';

import { PortalProvider } from '../../../src/portal/PortalProvider';
import { isFillRoute } from '../../../src/portal/routing';
import { PortalGate } from '../../../src/portal/shell/PortalGate';
import { ToastHost } from '../../../src/portal/ui/toast';

// Every signed-in screen. GET /api/me decides where the person may be (spec 4.3, src/portal/routing.ts); the
// groups below hold the frames: (access) the gate pages, (client) the client app, (account) two-step settings,
// and (console) the staff console. The toast host is around them all, so what an action did shows as a toast on
// every signed-in screen (spec 15.7, D55), raised on the screens that fill the window so it clears TownwiseAI's
// composer.
export default function PortalLayout(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <PortalProvider>
      <ToastHost raised={isFillRoute(pathname)}>
        <PortalGate />
      </ToastHost>
    </PortalProvider>
  );
}
