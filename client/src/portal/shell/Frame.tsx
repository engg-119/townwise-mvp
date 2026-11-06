import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { usePathname } from 'expo-router';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth, useAuthState } from '../../auth/AuthProvider';
import { theme } from '../../theme';
import { fetchPendingCount } from '../api';
import { COPY } from '../errors';
import { useAction } from '../hooks';
import { useOptionalPortal, usePortal, useReadOnly } from '../PortalProvider';
import { clientNav, consoleNav, isFillRoute, navLocationId } from '../routing';
import { ErrorNotice } from '../ui/feedback';
import { Wrap } from '../ui/layout';
import { MessageFocus } from '../ui/messageFocus';
import { Body } from '../ui/text';
import { Page } from './Page';
import { PortalStyles } from './PortalStyles';
import { Footer, TopBar } from './TopBar';
import { VIEW_AS_LINE_ID } from './ViewAsBanner';

// The four frames of spec 15.1 (Public is the existing sign-in). Each is a scroll view: the top bar, the page in
// <main>, then the slim footer. TownwiseAI fills the screen instead, so its frame does not scroll and has
// no footer. The shell around every frame holds the skip link (the first focusable element) and, during view-as,
// the banner above the frame, where it stays in view as the page scrolls.

type MainRef = RefObject<React.ComponentRef<typeof View> | null>;
const MainContext = createContext<MainRef | null>(null);

/** Skip to content: the first focusable element on web; hidden until it has focus. */
function SkipLink(props: { target: MainRef }): React.JSX.Element | null {
  const [focused, setFocused] = useState(false);
  if (Platform.OS !== 'web') return null;
  return (
    <Pressable
      role="link"
      onFocus={() => { setFocused(true); }}
      onBlur={() => { setFocused(false); }}
      onPress={() => { props.target.current?.focus(); }}
      style={[styles.skip, focused ? styles.skipShown : null]}
    >
      <Text style={styles.skipText}>Skip to content</Text>
    </Pressable>
  );
}

/** The root of every portal screen: the safe-area top, the skip link, the view-as banner, then the frame. */
export function Shell(props: { banner?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const main = useRef<React.ComponentRef<typeof View>>(null);
  const banner = props.banner !== undefined && props.banner !== null;
  return (
    <MainContext.Provider value={main}>
      <View nativeID="tw-portal" style={[styles.fill, { paddingTop: insets.top, backgroundColor: banner ? theme.color.raised : theme.color.ground }]}>
        <PortalStyles />
        <SkipLink target={main} />
        {props.banner}
        <View style={[styles.fill, styles.ground]}>{props.children}</View>
      </View>
    </MainContext.Provider>
  );
}

export function Frame(props: { topBar: React.ReactNode; children: React.ReactNode; fill?: boolean }): React.JSX.Element {
  const main = useContext(MainContext);
  const insets = useSafeAreaInsets();
  const mainProps = { ...(main === null ? {} : { ref: main }), role: 'main' as const, tabIndex: -1 as const };
  if (props.fill === true) {
    return (
      <View style={styles.fill}>
        {props.topBar}
        <View {...mainProps} style={styles.fill}>{props.children}</View>
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.grow}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    >
      {props.topBar}
      <View {...mainProps} style={styles.grow}>{props.children}</View>
      <Footer bottomInset={insets.bottom} />
    </ScrollView>
  );
}

/** Under view-as Sign out is disabled (spec 15.5), described by the banner's read-only line. */
function signOutState(readOnly: boolean): { signOutDisabled: boolean; signOutDescribedBy?: string } {
  return readOnly ? { signOutDisabled: true, signOutDescribedBy: VIEW_AS_LINE_ID } : { signOutDisabled: false };
}

/** Sign out, and the line that says it didn't work (web keeps the session when the server can't clear it). */
function useSignOut(): { run: () => void; failed: React.ReactNode } {
  const auth = useAuth();
  const action = useAction(useCallback(() => auth.signOut(), [auth]));
  const failed = action.error === null ? null : (
    <Wrap style={styles.signOutError}><ErrorNotice message={COPY.signOutFailed} /></Wrap>
  );
  return { run: action.run, failed };
}

/** Request access, Waiting, No access, Joining, Staff sign in again, and P7 for anyone without an organization. */
export function GateFrame(props: { children: React.ReactNode }): React.JSX.Element {
  const authState = useAuthState();
  const portal = useOptionalPortal();
  const { readOnly } = useReadOnly();
  const signOut = useSignOut();
  const email = portal?.me.user.email ?? (authState.status === 'signedIn' ? authState.user.email : '');
  return (
    <Frame topBar={<><TopBar kind="gate" email={email} {...signOutState(readOnly)} onSignOut={signOut.run} />{signOut.failed}</>}>
      {props.children}
    </Frame>
  );
}

/**
 * Members and org admins, and staff viewing as one of them. The top bar's sections open a location, so the frame
 * loads the organization (once per access, shared with every page) to know which ones there are.
 */
export function ClientFrame(props: { children: React.ReactNode }): React.JSX.Element {
  const { me, org, ensureOrg, lastLocationId } = usePortal();
  const pathname = usePathname();
  const { readOnly } = useReadOnly();
  const signOut = useSignOut();
  const { access } = me;
  const member = access.state === 'member';
  useEffect(() => { if (member && org === null) ensureOrg(); }, [member, org, ensureOrg]);
  if (access.state !== 'member') return <GateFrame>{props.children}</GateFrame>;
  const locations = org?.status === 'ready' ? org.data.locations : null;
  const bar = (
    <TopBar
      kind="client"
      email={me.user.email}
      orgName={access.org.name}
      nav={clientNav(access.role, pathname, navLocationId(pathname, lastLocationId, locations))}
      {...signOutState(readOnly)}
      onSignOut={signOut.run}
    />
  );
  return <Frame fill={isFillRoute(pathname)} topBar={<>{bar}{signOut.failed}</>}>{props.children}</Frame>;
}

/** P7 is the client app's for members and the gate's for everyone else (spec 16.1). */
export function AccountFrame(props: { children: React.ReactNode }): React.JSX.Element {
  const { me } = usePortal();
  return me.access.state === 'member' ? <ClientFrame>{props.children}</ClientFrame> : <GateFrame>{props.children}</GateFrame>;
}

export const CONSOLE_ON_WEB = 'The staff console is on the web. Open townwise.tech on a computer.';

/** The staff console (spec 15.4), on web only. Native builds show where to find it instead of its pages. */
export function ConsoleFrame(props: { children: React.ReactNode }): React.JSX.Element {
  if (Platform.OS !== 'web') {
    return (
      <GateFrame>
        <Page eyebrow="Townwise staff" title="Staff console" gate><Body>{CONSOLE_ON_WEB}</Body></Page>
      </GateFrame>
    );
  }
  return <WebConsoleFrame>{props.children}</WebConsoleFrame>;
}

const PendingCountContext = createContext<((count: number) => void) | null>(null);

function ignoreCount(): void {
  return undefined;
}

/** P19 hands the console nav the pending count each list read returns, so the nav and the Pending tab agree. */
export function useReportPendingCount(): (count: number) => void {
  return useContext(PendingCountContext) ?? ignoreCount;
}

function WebConsoleFrame(props: { children: React.ReactNode }): React.JSX.Element {
  const { me, api, pendingTick } = usePortal();
  const pathname = usePathname();
  const signOut = useSignOut();
  // Read on mount, on each move to another console page, and whenever approve or reject changes the list
  // (pendingTick); P19 also hands over the count from each list read. On /admin that is P19 itself, which reads
  // the same list, so the frame doesn't read it too. The last count stays up meanwhile, so the nav doesn't blink;
  // a failed read leaves it as it was.
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (pathname === '/admin') return undefined;
    let live = true;
    fetchPendingCount(api).then((next) => { if (live) setCount(next); }, () => undefined);
    return () => { live = false; };
  }, [api, pendingTick, pathname]);
  const bar = (
    <TopBar
      kind="console"
      email={me.user.email}
      nav={consoleNav(pathname, count)}
      verifiedUntil={me.staff?.verifiedUntil ?? null}
      onSignOut={signOut.run}
    />
  );
  return (
    <Frame topBar={<>{bar}{signOut.failed}</>}>
      <PendingCountContext.Provider value={setCount}>
        <MessageFocus>{props.children}</MessageFocus>
      </PendingCountContext.Provider>
    </Frame>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flexGrow: 1 },
  ground: { backgroundColor: c.ground },
  skip: {
    position: 'absolute', left: 16, top: -80, zIndex: 40, backgroundColor: c.mint, paddingVertical: 12, paddingHorizontal: 16,
  },
  skipShown: { top: 12 },
  skipText: { ...theme.type.ui, color: c.onMint },
  signOutError: { paddingTop: theme.space[4] },
});
