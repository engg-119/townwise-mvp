import { useEffect } from 'react';
import { Redirect, Slot, usePathname } from 'expo-router';

import { homeFor, isAllowed } from '../routing';
import { usePortal, usePortalContext } from '../PortalProvider';
import { ErrorNotice, LoadingLine } from '../ui/feedback';
import { Content, Wrap } from '../ui/layout';
import { GateFrame, Shell } from './Frame';
import { ViewAsBanner } from './ViewAsBanner';

// Access routing (spec 4.3). Until GET /api/me answers, “Checking your access”; if it can't be read, the shared
// error with Try again. Then each group's layout wraps its pages in AccessGuard: a path the person's access does
// not allow (routing.ts isAllowed) redirects to that access's own route, so a page never mounts in the wrong
// state. Staff in view-as are routed as the target, under the banner.
//
// The guard sits in the group layouts, not here: a <Redirect> in place of this <Slot> would unmount the
// navigator that owns the target route, the replace would then remount the whole portal one level up, and its
// state (the one-time notices among it) would be lost.

/** Redirects to the access's own route when it may not open this path; otherwise renders the page. */
export function AccessGuard(props: { children: React.ReactNode }): React.JSX.Element {
  const { me } = usePortal();
  const pathname = usePathname();
  if (!isAllowed(me, pathname)) return <Redirect href={homeFor(me)} />;
  return <>{props.children}</>;
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
  return (
    <Shell banner={me.viewAs === null ? null : <ViewAsBanner viewAs={me.viewAs} />}>
      <Slot />
    </Shell>
  );
}
