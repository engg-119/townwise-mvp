import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { locationEyebrow } from '../locations/naming';
import { useOrg, usePortal } from '../PortalProvider';
import { greeting } from '../profile/greeting';
import { useProfile } from '../profile/useProfile';
import { isFillRoute, locationHref, locationIdOf, pageTitle, tabOf } from '../routing';
import type { LocationSummary, MeResponse, OrgResponse } from '../schemas';
import { LinkButton } from '../ui/Button';
import { Skeleton, SkeletonHeading, SkeletonText } from '../skeleton/kit';
import { ErrorNotice, Notice } from '../ui/feedback';
import { Content, Wrap } from '../ui/layout';
import { MessageFocus } from '../ui/messageFocus';
import { Select } from '../ui/Select';
import { PageHeader, PageNotice } from './Page';

// The location pages' layout (spec 15.2, P11 to P16, P24, P25): the page header, then the page. The header's
// eyebrow is the town alone (“{town}, {state}”) when the organization has one location, and names the location when
// it has several (“{name}, {town}, {state}”, or “{name}, {state}” when the name already ends with its town:
// locations/naming.ts locationEyebrow, D29); the page's one h1 is the page's own title (pageTitle),
// except Home's, which greets the person by the name they gave Townwise (P11), and its side holds the location
// switcher and “All locations” when the organization has more than one location (Location settings is under the
// top bar's More). TownwiseAI has no page header at all (D26): the chat fills the screen
// under the top bar and draws its own hidden h1. The location's sections are in the top bar (Frame), so the pages
// render only their content. The page notice and the page share a MessageFocus, so a page that opens with a notice
// meant for it (Your data after an item's delete) can give that notice focus; a page with its own MessageFocus keeps
// its messages to it.

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

/** The organization the location layout is showing, or null outside it (the model card rendered on its own). */
export function useShownOrg(): OrgResponse | null {
  return useContext(ShownOrgContext);
}

/**
 * Home's title: “Welcome back, {name}.”, or “Welcome back.” while the name loads, if it can't be read, or with none
 * (P11). Under view-as it is the target's name. Only Home reads the profile.
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
    return (
      <Wrap>
        <Content>
          <View style={styles.loading}>
            <Skeleton name="location" label="Loading this location">
              <SkeletonHeading kicker big />
              <SkeletonText lines={3} />
            </Skeleton>
          </View>
        </Content>
      </Wrap>
    );
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
  const several = locations.length > 1;
  const eyebrow = locationEyebrow(location, several);
  const side = several ? (
    <>
      <Select
        label="Location"
        compact
        value={location.id}
        items={locations.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
        onChange={(id) => { router.push(locationHref(id, tab)); }}
      />
      <LinkButton href="/dashboard" label="All locations" />
    </>
  ) : undefined;
  const page = <ShownOrgContext.Provider value={shown}>{props.children}</ShownOrgContext.Provider>;
  if (isFillRoute(pathname)) return <View style={styles.fill}>{page}</View>;
  const header = (title: string): React.ReactNode => <PageHeader eyebrow={eyebrow} title={title} {...(side === undefined ? {} : { side })} />;
  const head = tab === 'home' ? <Greeting>{header}</Greeting> : header(pageTitle(tab, new Date()));
  return (
    <Wrap>
      {head}
      <Content>
        <MessageFocus>
          <PageNotice />
          {page}
        </MessageFocus>
      </Content>
    </Wrap>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The box the loading line kept, so the page below does not jump.
  loading: { minHeight: 240 },
  missing: { gap: theme.space[4], alignItems: 'flex-start' },
});
