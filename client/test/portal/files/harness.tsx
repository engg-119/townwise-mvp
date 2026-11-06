import type { ApiClient } from '../../../src/api/client';
import { AuthProvider } from '../../../src/auth/AuthProvider';
import { PortalProvider, usePortalContext } from '../../../src/portal/PortalProvider';
import type { MeResponse } from '../../../src/portal/schemas';
import { fakeAuth } from '../../helpers/fakes';
import { EMAIL, fakePortalApi, orgOf } from '../../helpers/portal';

// The portal around a component or hook under test: GET /api/me answers `me`, and every other call goes to `api`.
// Children render once the portal has the access, as they do under the portal layout.

function Ready(props: { children: React.ReactNode }): React.JSX.Element | null {
  return usePortalContext().portal === null ? null : <>{props.children}</>;
}

export function portalWrapper(api: ApiClient, me: MeResponse): (props: { children: React.ReactNode }) => React.JSX.Element {
  const portal = fakePortalApi({ me, org: orgOf(me.access.state === 'member' ? me.access.role : 'member'), fallback: api });
  const auth = fakeAuth({ status: 'signedIn', user: { id: 'u1', email: EMAIL } }, { api: portal });
  return function Wrapper(props: { children: React.ReactNode }): React.JSX.Element {
    return (
      <AuthProvider auth={auth}>
        <PortalProvider><Ready>{props.children}</Ready></PortalProvider>
      </AuthProvider>
    );
  };
}
