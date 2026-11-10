import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { townLabel } from '../format';
import { useBreakpoint } from '../hooks';
import { useOrg, usePortal } from '../PortalProvider';
import { greeting } from '../profile/greeting';
import { useProfile } from '../profile/useProfile';
import { isFillRoute, locationHref, locationIdOf, pageTitle, tabOf } from '../routing';
import type { LocationSummary, MeResponse, OrgResponse } from '../schemas';
import { LinkButton } from '../ui/Button';
import { ErrorNotice, LoadingLine, Notice } from '../ui/feedback';
import { Content, Wrap } from '../ui/layout';
import { Select } from '../ui/Select';
import { Eyebrow, Title } from '../ui/text';
import { PageHeader, PageNotice } from './Page';

// The location pages' layout (spec 15.2, P11 to P16, P24, P25): the page header, then the page. The header's
// eyebrow names the location (“{name}, {town}, {state}”), the page's one h1 is the page's own title (pageTitle),
// except TownwiseAI's, which greets the person by the name they gave Townwise (D26), and its side holds the location
// switcher and “All locations” when the organization has more than one location, and “Location settings” for org
// admins. The location's sections are in the top bar (Frame), so the pages render only their content.

/** The organization the layout is showing (see LocationShell), for its pages. */
const ShownOrgContext = createContext<OrgResponse | null>(null);

/** The location this layout is showing; its pages read it instead of loading the organization again. */
export function useLocation(): { location: LocationSummary; org: OrgResponse } {
  const locationId = locationIdOf(usePathname());
  const org = useContext(ShownOrgContext);
  const location = org?.locations.find((candidate) => candidate.id === locationId);
  if (org === null || location === undefined) throw new Error('useLocation must be used inside the location layout');
  return { location, org };
}

/**
 * On phones TownwiseAI needs the screen: the layout hands it a compact header (the eyebrow, and the title on one
 * line, with no switcher or links) instead of drawing it above it, and the page puts it at the top of its
 * thread, so it scrolls away with the conversation. Null on every other page, and on wider screens.
 */
const ScrollingHeadContext = createContext<React.ReactNode>(null);

export function useScrollingHead(): React.ReactNode {
  return useContext(ScrollingHeadContext);
}

/**
 * TownwiseAI's title: “Welcome back, {name}.”, or “Welcome back.” while the name loads, if it can't be read, or with
 * none (P25). Under view-as it is the target's name. Only this page reads the profile.
 */
function Greeting(props: { children: (title: string) => React.ReactNode }): React.JSX.Element {
  const { profile } = useProfile();
  return <>{props.children(greeting(profile?.displayName ?? null))}</>;
}

export function LocationShell(props: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const locationId = locationIdOf(pathname);
  const router = useRouter();
  const { me, openedLocation } = usePortal();
  const { state, reload } = useOrg();
  const { phone } = useBreakpoint();
  const role = me.access.state === 'member' ? me.access.role : 'member';
  // While the organization reloads after a write, the layout keeps showing the answer before it, so the page
  // stays mounted. Hiding it would unmount the location's navigator, and expo-router would move the address to
  // the location's first page (Home) before the new answer arrived. A location the old answer lacks waits.
  // A new GET /api/me clears cached organization data (spec 4.3), so the old answer is kept only for the `me` it
  // was read under.
  const [previous, setPrevious] = useState<{ org: OrgResponse; me: MeResponse } | null>(null);
  if (state.status === 'ready' && (previous?.org !== state.data || previous.me !== me)) setPrevious({ org: state.data, me });
  const kept = previous?.me === me ? previous.org : null;
  const shown = state.status === 'ready' ? state.data : state.status === 'loading' ? kept : null;
  const location = shown?.locations.find((candidate) => candidate.id === locationId);
  const shownId = location?.id;
  // The top bar's sections open this location from pages outside one, until another opens (memory only).
  useEffect(() => { if (shownId !== undefined) openedLocation(shownId); }, [shownId, openedLocation]);

  if (state.status === 'failed') {
    return <Wrap><Content><ErrorNotice error={state.error} onRetry={reload} /></Content></Wrap>;
  }
  if (shown === null || (location === undefined && state.status === 'loading')) {
    return <Wrap><Content><LoadingLine text="Loading this location" minHeight={240} /></Content></Wrap>;
  }
  const { locations } = shown;
  if (location === undefined) {
    return (
      <Wrap>
        <Content>
          <View style={styles.missing}>
            <Notice text="This location isn’t available." />
            <LinkButton variant="link" href="/dashboard" label="Locations" />
          </View>
        </Content>
      </Wrap>
    );
  }
  const tab = tabOf(pathname);
  const eyebrow = `${location.name}, ${townLabel(location.town)}`;
  const titled = (draw: (title: string) => React.ReactNode): React.ReactNode => (
    tab === 'agent' ? <Greeting>{draw}</Greeting> : draw(pageTitle(tab, new Date()))
  );
  const several = locations.length > 1;
  const side = several || (role === 'org_admin' && tab !== 'settings') ? (
    <>
      {several ? (
        <Select
          label="Location"
          compact
          value={location.id}
          items={locations.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
          onChange={(id) => { router.push(locationHref(id, tab)); }}
        />
      ) : null}
      {several ? <LinkButton href="/dashboard" label="All locations" /> : null}
      {role === 'org_admin' && tab !== 'settings' ? <LinkButton href={locationHref(location.id, 'settings')} label="Location settings" /> : null}
    </>
  ) : undefined;
  const page = <ShownOrgContext.Provider value={shown}>{props.children}</ShownOrgContext.Provider>;
  if (isFillRoute(pathname) && phone) {
    const compact = titled((title) => (
      <View style={styles.compact}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <Title lines={1}>{title}</Title>
      </View>
    ));
    return (
      <ScrollingHeadContext.Provider value={compact}>
        <View style={styles.fill}>{page}</View>
      </ScrollingHeadContext.Provider>
    );
  }
  const head = titled((title) => <PageHeader eyebrow={eyebrow} title={title} {...(side === undefined ? {} : { side })} />);
  if (isFillRoute(pathname)) {
    return (
      <View style={styles.fill}>
        <Wrap>{head}</Wrap>
        <View style={styles.fill}>{page}</View>
      </View>
    );
  }
  return (
    <Wrap>
      {head}
      <Content>
        <PageNotice />
        {page}
      </Content>
    </Wrap>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  missing: { gap: theme.space[4], alignItems: 'flex-start' },
  compact: { gap: theme.space[1] },
});
