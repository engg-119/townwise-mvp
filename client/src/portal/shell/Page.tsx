import { useEffect } from 'react';
import { usePathname } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { useOptionalPortal } from '../PortalProvider';
import { Notice } from '../ui/feedback';
import { Content, Wrap } from '../ui/layout';
import { Body, Eyebrow, Heading, Lead, Title } from '../ui/text';

// The page header and the page body (spec 15.2). Every page that is not a location tab renders <Page>: the
// eyebrow and the page's one h1 in columns 1 to 8, its actions (at most one primary) or a side column in 9 to
// 12, then the one-time notice and the content. Gate pages add the lead under the title in columns 1 to 7.

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  /** Gate pages: the lead paragraph under the title. */
  lead?: React.ReactNode;
  /** Gate pages: actions under the lead (Check again, Join). */
  leadActions?: React.ReactNode;
  /** The right side: the page's actions, the location switcher, or a gate page's side column. */
  side?: React.ReactNode;
  /** Gate layout: the left column is the reading width (1 to 7) and the side column aligns to the top. */
  gate?: boolean;
}

export function PageHeader(props: PageHeaderProps): React.JSX.Element {
  const { desktop } = useBreakpoint();
  const gate = props.gate === true;
  const left = (
    <View style={styles.left}>
      {props.eyebrow === undefined ? null : <Eyebrow>{props.eyebrow}</Eyebrow>}
      <Title>{props.title}</Title>
      {props.lead === undefined ? null : (typeof props.lead === 'string' ? <Lead style={styles.lead}>{props.lead}</Lead> : props.lead)}
      {props.leadActions}
    </View>
  );
  const side = props.side === undefined ? null : (
    <View style={gate ? styles.sideColumn : [styles.side, desktop ? styles.sideEnd : null]}>{props.side}</View>
  );
  if (!desktop) {
    return <View style={styles.header}>{left}{side}</View>;
  }
  return (
    <View style={[styles.header, styles.row, gate ? styles.alignStart : styles.alignEnd]}>
      <View style={{ flex: gate ? 7 : 8, minWidth: 0 }}>{left}</View>
      {gate ? <View style={styles.gap} /> : null}
      <View style={{ flex: 4, minWidth: 0 }}>{side}</View>
    </View>
  );
}

/** The one-time notice of PortalProvider.showNotice, at the top of the content. */
export function PageNotice(): React.JSX.Element | null {
  const portal = useOptionalPortal();
  const pathname = usePathname();
  const stored = portal?.notice ?? null;
  const visible = stored !== null
    && (stored.where === null || stored.where.test(pathname))
    && (stored.shownAt === null || stored.shownAt === pathname);
  const unmarked = visible && stored.shownAt === null;
  const mark = portal?.markNoticeShown;
  useEffect(() => { if (unmarked) mark?.(pathname); }, [unmarked, mark, pathname]);
  if (!visible) return null;
  return (
    <View style={styles.notice}>
      <Notice text={stored.notice.text} {...(stored.notice.link === undefined ? {} : { link: stored.notice.link })} />
    </View>
  );
}

export interface PageProps extends PageHeaderProps {
  children?: React.ReactNode;
  /** False while the page may still redirect (Locations with one location), so the notice waits for the next page. */
  notice?: boolean;
}

/** A whole page inside its frame: header, the one-time notice, then the content. */
export function Page(props: PageProps): React.JSX.Element {
  const { children, notice, ...header } = props;
  return (
    <Wrap>
      <PageHeader {...header} />
      <Content>
        {notice === false ? null : <PageNotice />}
        {children}
      </Content>
    </Wrap>
  );
}

/** The line every page not built yet shows, under its title. */
export const PLACEHOLDER_LINE = 'This page is being built.';

/** A page not built yet: its title and one line, inside its frame. Replace the route file to build it. */
export function Placeholder(props: { title: string; eyebrow?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <Page title={props.title} {...(props.eyebrow === undefined ? {} : { eyebrow: props.eyebrow })}>
      <View style={styles.tab}>
        <Body>{PLACEHOLDER_LINE}</Body>
        {props.children}
      </View>
    </Page>
  );
}

/** A location tab not built yet: the tab's name as its heading and one line, under the location's header. */
export function TabPlaceholder(props: { title: string }): React.JSX.Element {
  return (
    <View style={styles.tab}>
      <Heading>{props.title}</Heading>
      <Body>{PLACEHOLDER_LINE}</Body>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingTop: theme.space[8], paddingBottom: theme.space[6], rowGap: theme.space[5] },
  row: { flexDirection: 'row', columnGap: theme.space.gutter },
  alignEnd: { alignItems: 'flex-end' },
  alignStart: { alignItems: 'flex-start' },
  gap: { flex: 1 },
  left: { gap: theme.space[3] },
  lead: { marginTop: theme.space[1] },
  side: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', columnGap: theme.space[5], rowGap: theme.space[3] },
  sideEnd: { justifyContent: 'flex-end' },
  sideColumn: { gap: theme.space[3] },
  notice: { marginBottom: theme.space[8] },
  tab: { gap: theme.space[3] },
});
