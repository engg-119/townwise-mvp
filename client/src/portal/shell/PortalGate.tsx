import { useCallback, useEffect } from 'react';
import { Redirect, Slot, usePathname } from 'expo-router';

import { useAuth } from '../../auth/AuthProvider';
import { COPY } from '../errors';
import { useAction } from '../hooks';
import { MomentProvider } from '../moments';
import { homeFor, isAllowed } from '../routing';
import { usePortal, usePortalContext } from '../PortalProvider';
import type { MeResponse } from '../schemas';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { Content, Wrap } from '../ui/layout';
import { GateFrame, Shell } from './Frame';
import { OpenAsAdminBanner } from './OpenAsAdminBanner';
import { ViewAsBanner } from './ViewAsBanner';

// Access routing (spec 4.3). Until GET /api/me answers, “Checking your access”; if it can't be read, the shared
// error with Try again. Then each group's layout wraps its pages in AccessGuard: a path the person's access does
// not allow (routing.ts isAllowed) redirects to that access's own route, so a page never mounts in the wrong
// state. Staff in view-as are routed as the target, under the banner; staff opening an organization as its admin, as that admin.
//
// The guard sits in the group layouts, not here: a <Redirect> in place of this <Slot> would unmount the
// navigator that owns the target route, the replace would then remount the whole portal one level up, and its
// state (the one-time notices among it) would be lost.
//
// Once GET /api/me has answered, MomentProvider wraps the <Slot> and plays the statement moments (spec 15.8) over
// the frame. It always renders the Slot first and in the same place, so the navigator never remounts.

/**
 * Redirects to the access's own route when it may not open this path; otherwise renders the page. A staff session
 * that has to sign in again with a code (staff_reauth_required) has no route of its own: it is signed out, and the
 * gate opens the ordinary sign-in page with the reason as its notice.
 */
export function AccessGuard(props: { children: React.ReactNode }): React.JSX.Element {
  const { me } = usePortal();
  const pathname = usePathname();
  if (!isAllowed(me, pathname)) {
    const home = homeFor(me);
    return home === null ? <StaffSignOut access={me.access} /> : <Redirect href={home} />;
  }
  return <>{props.children}</>;
}

const REAUTH_NOTICE = {
  session_before_codes: 'Two-step sign-in is on. Sign in again with your code.',
  session_too_old: 'Staff sessions need a fresh sign-in with your code every 60 minutes.',
} as const;

/** Signs out once on mount; a failed sign-out (web, offline) says so with Try again. */
function StaffSignOut(props: { access: MeResponse['access'] }): React.JSX.Element {
  const auth = useAuth();
  const { access } = props;
  const notice = access.state === 'staff_reauth_required' ? REAUTH_NOTICE[access.reason] : undefined;
  const signOut = useAction(useCallback(() => auth.signOut(notice), [auth, notice]));
  const { run } = signOut;
  useEffect(() => { run(); }, [run]);
  return (
    <GateFrame>
      <Wrap>
        <Content>
          {signOut.error === null
            ? <LoadingLine text="Signing you out" minHeight={240} />
            : <ErrorNotice message={COPY.signOutFailed} onRetry={run} />}
        </Content>
      </Wrap>
    </GateFrame>
  );
}

export function PortalGate(): React.JSX.Element {
  const { meState, retry, leftPath } = usePortalContext();
  const pathname = usePathname();
  useEffect(() => { leftPath(pathname); }, [leftPath, pathname]);

  if (meState.status !== 'ready') {
    return (
      <Shell>
        <GateFrame>
          <Wrap>
            <Content>
              {meState.status === 'loading'
                ? <LoadingLine text="Checking your access" minHeight={240} />
                : <ErrorNotice error={meState.error} onRetry={retry} />}
            </Content>
          </Wrap>
        </GateFrame>
      </Shell>
    );
  }
  const { me } = meState;
  const banner = me.viewAs !== null
    ? <ViewAsBanner viewAs={me.viewAs} />
    : me.openAsAdmin != null ? <OpenAsAdminBanner openAsAdmin={me.openAsAdmin} /> : null;
  return (
    <Shell banner={banner}>
      <MomentProvider>
        <Slot />
      </MomentProvider>
    </Shell>
  );
}
