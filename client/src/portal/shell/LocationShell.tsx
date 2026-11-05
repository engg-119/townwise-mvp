import { createContext, useContext, useState } from 'react';
import { Link, usePathname, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { townLabel } from '../format';
import { useBreakpoint } from '../hooks';
import { useOrg, usePortal } from '../PortalProvider';
import { isFillRoute, locationHref, locationIdOf, locationTabs, tabOf, type LocationTab } from '../routing';
import type { LocationSummary, MeResponse, OrgResponse } from '../schemas';
import { webAria } from '../ui/aria';
import { LinkButton } from '../ui/Button';
import { ErrorNotice, LoadingLine, Notice } from '../ui/feedback';
import { Content, Wrap } from '../ui/layout';
import { Select } from '../ui/Select';
import { PageHeader, PageNotice } from './Page';

// The location pages' layout (spec 15.2, P11 to P16): the page header (eyebrow “{town}, {state}”, the location's
// name as the h1, and the location switcher when the organization has more than one location), then the tabs,
// then the tab's page. The tab pages render only their content.

/** The organization the layout is showing (see LocationShell), for its tab pages. */
const ShownOrgContext = createContext<OrgResponse | null>(null);

/** The location this layout is showing; tab pages read it instead of loading the organization again. */
export function useLocation(): { location: LocationSummary; org: OrgResponse } {
  const locationId = locationIdOf(usePathname());
  const org = useContext(ShownOrgContext);
  const location = org?.locations.find((candidate) => candidate.id === locationId);
  if (org === null || location === undefined) throw new Error('useLocation must be used inside the location layout');
  return { location, org };
}

/**
 * On phones the Chat tab needs the screen: the layout hands it the location's header and tabs instead of drawing
 * them above it, and the chat puts them at the top of its thread, so they scroll away with the conversation.
 * Null on every other page, and on wider screens.
 */
const ScrollingHeadContext = createContext<React.ReactNode>(null);

export function useScrollingHead(): React.ReactNode {
  return useContext(ScrollingHeadContext);
}

function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

function Tab(props: { tab: LocationTab }): React.JSX.Element {
  const { tab } = props;
  return (
    <Link href={tab.href} asChild>
      <Pressable
        role="link"
        accessibilityState={{ selected: tab.current }}
        {...webAria({ 'aria-current': tab.current ? 'page' : undefined })}
        style={(state) => [styles.tab, tab.current ? styles.tabOn : hovered(state) ? styles.tabHover : null]}
      >
        <View style={[styles.square, tab.current ? styles.squareOn : null]} />
        <Text style={[styles.tabText, tab.current ? styles.tabTextOn : null]}>{tab.label}</Text>
      </Pressable>
    </Link>
  );
}

/** The location's sections, in a focusable region that scrolls sideways when it doesn't fit. */
export function LocationTabs(props: { tabs: readonly LocationTab[] }): React.JSX.Element {
  return (
    <View role="region" aria-label="Location sections" focusable style={styles.tabsRegion}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsScroll}>
        <View role="navigation" aria-label="Location" style={styles.tabs}>
          {props.tabs.map((tab) => <Tab key={tab.key} tab={tab} />)}
        </View>
      </ScrollView>
    </View>
  );
}

export function LocationShell(props: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const locationId = locationIdOf(pathname);
  const router = useRouter();
  const { me } = usePortal();
  const { state, reload } = useOrg();
  const { phone } = useBreakpoint();
  const role = me.access.state === 'member' ? me.access.role : 'member';
  // While the organization reloads after a write, the layout keeps showing the answer before it, so the tab page
  // stays mounted. Hiding it would unmount the location's navigator, and expo-router would move the address to
  // the location's first tab (Forecast) before the new answer arrived. A location the old answer lacks waits.
  // A new GET /api/me clears cached organization data (spec 4.3), so the old answer is kept only for the `me` it
  // was read under.
  const [previous, setPrevious] = useState<{ org: OrgResponse; me: MeResponse } | null>(null);
  if (state.status === 'ready' && (previous?.org !== state.data || previous.me !== me)) setPrevious({ org: state.data, me });
  const kept = previous?.me === me ? previous.org : null;
  const shown = state.status === 'ready' ? state.data : state.status === 'loading' ? kept : null;
  const location = shown?.locations.find((candidate) => candidate.id === locationId);

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
  const switcher = locations.length > 1 ? (
    <Select
      label="Location"
      compact
      value={location.id}
      items={locations.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
      onChange={(id) => { router.push(locationHref(id, tabOf(pathname))); }}
    />
  ) : undefined;
  const head = (
    <>
      <PageHeader eyebrow={townLabel(location.town)} title={location.name} {...(switcher === undefined ? {} : { side: switcher })} />
      <LocationTabs tabs={locationTabs(location.id, role, pathname)} />
    </>
  );
  const page = <ShownOrgContext.Provider value={shown}>{props.children}</ShownOrgContext.Provider>;
  if (isFillRoute(pathname) && phone) {
    return (
      <ScrollingHeadContext.Provider value={head}>
        <View style={styles.fill}>{page}</View>
      </ScrollingHeadContext.Provider>
    );
  }
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

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  missing: { gap: theme.space[4], alignItems: 'flex-start' },
  tabsRegion: { marginHorizontal: -4, borderBottomWidth: 1, borderBottomColor: c.border },
  tabsScroll: { flexGrow: 1 },
  tabs: { flexDirection: 'row', columnGap: 4, padding: 4 },
  tab: {
    flexDirection: 'row', alignItems: 'center', columnGap: 8, minHeight: 44, paddingHorizontal: 12, borderWidth: 1,
    borderColor: 'transparent',
  },
  tabHover: { backgroundColor: c.raised },
  tabOn: { backgroundColor: c.raised, borderColor: c.border },
  square: { width: 6, height: 6 },
  squareOn: { backgroundColor: c.mint },
  tabText: { ...theme.type.ui, color: c.text2 },
  tabTextOn: { color: c.mint },
});
