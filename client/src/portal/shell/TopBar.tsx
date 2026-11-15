import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, usePathname } from 'expo-router';
import {
  Platform, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type LayoutRectangle, type PressableStateCallbackType,
} from 'react-native';

import { theme } from '../../theme';
import { formatTime } from '../format';
import { useBreakpoint } from '../hooks';
import type { NavItem } from '../routing';
import { webAria } from '../ui/aria';
import { Button } from '../ui/Button';
import { StatusTag } from '../ui/feedback';
import { Wrap } from '../ui/layout';
import { ThemeToggle } from './ThemeToggle';

// The top bars of spec 15.1 to 15.4 (shell.md 5.1 to 5.4). At least 64px with a 1px `border` rule below:
// - gate: `ground`; wordmark; “Signed in as {email}” and Sign out;
// - client app: `ground`; wordmark, a 20px rule, the organization name, the nav (the location's sections, then
//   Team and Settings as a group on the right), the email and Sign out;
// - staff console: `panel`; wordmark and the “Staff console” kind tag, the nav with “Requests {n}”, then
//   “Verified until {time}”, the staff email and Sign out.
// On web every bar has the light and dark switch (ThemeToggle, a 44px square) just before Sign out; native has none.
// Nav links never hide: below 900px (1024px in the console, 1280px when the client app's bar carries a
// location's sections, which need the room) they take a second row under a rule. At 640px and
// below the email hides and the organization name truncates; the console's bar is one band of two 44px rows and the
// nav: the wordmark, kind tag and switch, then “Verified until” and Sign out (the wordmark, kind tag, switch and Sign
// out are too wide for one 320px row). The client app's second row is then one line in a
// focusable region that scrolls sideways, kept on the current section.
// The client app's Notes, Rules, Town and Your data sit under More (D38), a disclosure where the first of them was:
// on web above 640px its links drop down under it in a `panel` box over the page; on phones and native they take a
// row under the bar.

export interface TopBarProps {
  kind: 'gate' | 'client' | 'console';
  email: string;
  orgName?: string;
  nav?: readonly NavItem[];
  /** The console's staff.verifiedUntil, printed as a time, never a counter. */
  verifiedUntil?: string | null;
  /** View-as: End view-as is the way out. */
  signOutDisabled?: boolean;
  /** The id of the line that says why Sign out is disabled. */
  signOutDescribedBy?: string;
  onSignOut: () => void;
}

function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

type Measure = (key: string, layout: LayoutRectangle) => void;

function NavLink(props: { item: NavItem; onMeasure?: Measure | undefined; inBox?: boolean }): React.JSX.Element {
  const { item, onMeasure } = props;
  const current = item.current !== null;
  return (
    <Link href={item.href} asChild>
      <Pressable
        role="link"
        accessibilityState={{ selected: current }}
        {...webAria({ 'aria-current': item.current ?? undefined })}
        {...(onMeasure === undefined ? {} : { onLayout: (event: LayoutChangeEvent) => { onMeasure(item.href, event.nativeEvent.layout); } })}
        style={StyleSheet.flatten([styles.navLink, props.inBox === true ? styles.boxLink : null])}
      >
        {(state) => (
          <Text style={[styles.navText, current || hovered(state) ? styles.white : null]}>
            {item.label}
            {item.count === undefined || item.count === null ? null : <Text style={styles.count}>{` ${String(item.count)}`}</Text>}
          </Text>
        )}
      </Pressable>
    </Link>
  );
}

/** More's state (D38), from the bar to the nav that draws it. */
interface MoreGroup {
  /** The items under More, in order. */
  items: readonly NavItem[];
  open: boolean;
  /** On web above 640px the links drop down under More, inside the nav; elsewhere the bar draws them in a row under it. */
  floating: boolean;
  /** The links' container, named by aria-controls while open; More's button and box take ids built from it (moreIds). */
  id: string;
  onToggle: () => void;
}

/** The ids of More's button, where Escape returns focus, and its box: More and, when floating, its links. */
function moreIds(id: string): { button: string; box: string } {
  return { button: `${id}-button`, box: `${id}-box` };
}

/** The key the phone row measures More under, beside the links' hrefs. */
const MORE_KEY = 'more';

/**
 * More: a disclosure over the grouped sections, white while open, hovered or holding the current page, with the
 * select's drawn chevron, which turns up while open.
 */
function More(props: { group: MoreGroup; onMeasure?: Measure | undefined }): React.JSX.Element {
  const { group, onMeasure } = props;
  const holdsCurrent = group.items.some((item) => item.current !== null);
  return (
    <View
      nativeID={moreIds(group.id).box}
      {...(onMeasure === undefined ? {} : { onLayout: (event: LayoutChangeEvent) => { onMeasure(MORE_KEY, event.nativeEvent.layout); } })}
      style={styles.more}
    >
      <Pressable
        nativeID={moreIds(group.id).button}
        role="button"
        aria-expanded={group.open}
        {...(group.open ? { 'aria-controls': group.id } : {})}
        accessibilityState={{ expanded: group.open }}
        onPress={group.onToggle}
        style={styles.navLink}
      >
        {(state) => {
          const lit = group.open || holdsCurrent || hovered(state);
          return (
            <View style={styles.moreLabel}>
              <Text style={[styles.navText, lit ? styles.white : null]}>More</Text>
              <View style={[styles.chevron, lit ? styles.chevronLit : null, group.open ? styles.chevronOpen : null]} />
            </View>
          );
        }}
      </Pressable>
      {group.floating && group.open ? (
        <View nativeID={group.id} style={styles.dropdown}>
          {group.items.map((item) => <NavLink key={item.href} item={item} inBox />)}
        </View>
      ) : null}
    </View>
  );
}

/** The bar's entries in order: each link, with the grouped ones replaced by More where the first of them was. */
function entries(items: readonly NavItem[], group: MoreGroup | null, onMeasure?: Measure): React.JSX.Element[] {
  const first = items.findIndex((item) => item.more === true);
  return items.flatMap((item, index) => {
    if (item.more !== true || group === null) return [<NavLink key={item.href} item={item} onMeasure={onMeasure} />];
    return index === first ? [<More key={MORE_KEY} group={group} onMeasure={onMeasure} />] : [];
  });
}

/** The nav, with the items from the first `end` one on as a group at the row's far end. */
function Nav(props: { items: readonly NavItem[]; wrapped: boolean; group: MoreGroup | null }): React.JSX.Element {
  const gap = { columnGap: props.wrapped ? 20 : 24 };
  const split = props.items.findIndex((item) => item.end === true);
  if (split <= 0) {
    return (
      <View role="navigation" aria-label="Main" style={[styles.nav, gap]}>
        {entries(props.items, props.group)}
      </View>
    );
  }
  return (
    <View role="navigation" aria-label="Main" style={[styles.nav, styles.navSplit, gap]}>
      {entries(props.items.slice(0, split), props.group)}
      <View style={[styles.navEnd, gap]}>
        {entries(props.items.slice(split), props.group)}
      </View>
    </View>
  );
}

/**
 * More's links in a row under the bar (phones and native), a navigation of their own, as the phone row's ScrollView
 * would clip a dropdown. In the flow it covers nothing, so it stays open until More, Escape or another page closes it,
 * and Tab reaches it after the row's last links.
 */
function MoreRow(props: { group: MoreGroup }): React.JSX.Element {
  return (
    <View nativeID={props.group.id} role="navigation" aria-label="More" style={styles.navRow}>
      <View style={[styles.nav, styles.moreRow]}>
        {props.group.items.map((item) => <NavLink key={item.href} item={item} />)}
      </View>
    </View>
  );
}

/**
 * On web, Escape with focus on More or one of its links closes it and hands focus back to More (an Escape meant for
 * anything else on the page is left alone). The dropdown, which covers the page, also closes on a press or focus
 * outside More and its links, leaving focus where it went. Native closes it when More is pressed again or the page
 * changes. react-native-web renders nativeID as the element's id, so the elements are found by id.
 */
function useDismiss(open: boolean, floating: boolean, id: string, close: () => void): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return undefined;
    const { box, button } = moreIds(id);
    const inside = (target: EventTarget | null): boolean => target instanceof Node
      && [box, id].some((part) => document.getElementById(part)?.contains(target) === true);
    const onOutside = (event: Event): void => { if (!inside(event.target)) close(); };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !inside(document.activeElement)) return;
      close();
      document.getElementById(button)?.focus();
    };
    document.addEventListener('keydown', onKey);
    if (floating) {
      document.addEventListener('pointerdown', onOutside);
      document.addEventListener('focusin', onOutside);
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, [open, floating, id, close]);
}

/** The phone gutter the scroller reaches into, so a link's focus ring at either end is not cut off. */
const BLEED = 16;

/**
 * The client app's nav on phones: one row in a focusable region that scrolls sideways when it doesn't fit, as
 * far into the margins as the screen. The row scrolls (without animating) to keep the current item in view, on
 * mount and whenever the route changes.
 */
function ScrollingNav(props: { items: readonly NavItem[]; group: MoreGroup | null }): React.JSX.Element {
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [viewport, setViewport] = useState(0);
  const [spans, setSpans] = useState<Readonly<Record<string, { x: number; width: number }>>>({});
  // A current section under More keeps More in view.
  const currentItem = props.items.find((item) => item.current !== null);
  const current = currentItem === undefined ? undefined : currentItem.more === true && props.group !== null ? MORE_KEY : currentItem.href;
  const span = current === undefined ? undefined : spans[current];
  // The least scroll that shows the whole current item and the margin after it: none for the first items, the
  // row's end for the last. A link's x is measured from the nav, which starts after the row's BLEED.
  const target = span === undefined || viewport === 0 ? null : Math.max(0, BLEED + span.x + span.width + BLEED - viewport);
  useEffect(() => {
    if (target !== null) scroller.current?.scrollTo({ x: target, animated: false });
  }, [current, target]);
  const measure = useCallback((key: string, { x, width }: LayoutRectangle) => {
    setSpans((before) => (before[key]?.x === x && before[key].width === width ? before : { ...before, [key]: { x, width } }));
  }, []);
  return (
    <View
      role="region"
      aria-label="Sections"
      focusable
      onLayout={(event) => { setViewport(event.nativeEvent.layout.width); }}
      style={styles.scrollRegion}
    >
      <ScrollView ref={scroller} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollRow}>
        {/* Keyed by the items: when the sections arrive (the organization loaded) the links mount again and measure
            where they now sit, as the web's onLayout reports a change of size, not a move. */}
        <View key={props.items.map((item) => item.href).join(' ')} role="navigation" aria-label="Main" style={[styles.nav, styles.navLine]}>
          {entries(props.items, props.group, measure)}
        </View>
      </ScrollView>
    </View>
  );
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { phone, width } = useBreakpoint();
  const consoleBar = props.kind === 'console';
  const sections = (props.nav ?? []).findIndex((item) => item.end === true) > 0;
  // More opened on one page reads as closed on any other: it holds the path and nav it was opened on, so following a
  // link, the location switcher or any other move closes it without an effect. The path counts on its own, since
  // pages such as Location settings and Locations draw the same nav.
  const pathname = usePathname();
  const where = [pathname, ...(props.nav ?? []).map((item) => `${item.href} ${item.current ?? ''}`)].join('\n');
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === where;
  const moreId = `more-${useId().replace(/:/g, '')}`;
  const close = useCallback(() => { setOpenOn(null); }, []);
  const grouped = (props.nav ?? []).filter((item) => item.more === true);
  const floating = Platform.OS === 'web' && !phone;
  useDismiss(open && grouped.length > 0, floating, moreId, close);
  const group: MoreGroup | null = grouped.length === 0 ? null : {
    items: grouped,
    open,
    floating,
    id: moreId,
    onToggle: () => { setOpenOn(open ? null : where); },
  };
  const wrapped = width < (consoleBar ? 1024 : sections ? 1280 : 900);
  const home = consoleBar ? '/admin' : '/dashboard';
  const signOut = (
    <Button
      variant="link"
      label="Sign out"
      disabled={props.signOutDisabled === true}
      {...(props.signOutDescribedBy === undefined ? {} : { describedBy: props.signOutDescribedBy })}
      onPress={props.onSignOut}
    />
  );
  // At 640px and below the gaps tighten to 12px and Sign out holds its width: the organization name takes the
  // squeeze and truncates with an ellipsis, so Sign out stays inside the 16px margin at 320px and never wraps. The
  // console has no organization name to squeeze, so its kind tag keeps the 16px gap from the wordmark.
  const tight = phone ? styles.tight : null;
  const identity = (
    <View style={[styles.identity, consoleBar ? null : tight]}>
      <Link href={home} style={styles.wordmark}>Townwise</Link>
      {props.orgName === undefined ? null : (
        <View style={[styles.org, tight]}>
          <View style={styles.rule} />
          <Text numberOfLines={1} style={styles.orgName}>{props.orgName}</Text>
        </View>
      )}
      {consoleBar ? <View style={styles.tagSlot}><StatusTag label="Staff console" /></View> : null}
    </View>
  );
  const verified = props.verifiedUntil === undefined || props.verifiedUntil === null ? null : (
    <Text style={styles.mail}>{`Verified until ${formatTime(props.verifiedUntil)}`}</Text>
  );
  const stackedConsole = consoleBar && phone;
  // The switch and Sign out, held together at their own widths.
  const end = <View style={styles.end}><ThemeToggle />{signOut}</View>;
  let me: React.JSX.Element;
  if (stackedConsole) {
    // The switch on the wordmark's row and Sign out under it, on the row of “Verified until”; neither shrinks.
    me = <View style={[styles.me, styles.hold, styles.meStacked]}><ThemeToggle />{signOut}</View>;
  } else if (phone) {
    // Only the switch and Sign out, which never shrink.
    me = <View style={[styles.me, styles.hold]}>{end}</View>;
  } else if (consoleBar) {
    me = (
      <View style={styles.me}>
        <View style={styles.status}>
          {verified}
          <Text numberOfLines={1} style={styles.mail}>{props.email}</Text>
        </View>
        {end}
      </View>
    );
  } else {
    me = (
      <View style={styles.me}>
        <Text numberOfLines={1} style={[styles.mail, styles.shrink]}>
          {props.kind === 'gate' ? `Signed in as ${props.email}` : props.email}
        </Text>
        {end}
      </View>
    );
  }
  const nav = props.nav === undefined || props.nav.length === 0 ? null : props.nav;
  let navRow: React.ReactNode = null;
  if (nav !== null && wrapped) {
    navRow = (
      <View style={styles.navRow}>
        {phone && props.kind === 'client' ? <ScrollingNav items={nav} group={group} /> : <Nav items={nav} wrapped group={group} />}
      </View>
    );
  }
  return (
    <View role="banner" style={[styles.bar, consoleBar ? styles.panel : null, group?.floating === true && group.open ? styles.lifted : null]}>
      <Wrap>
        <View style={[styles.row, tight]}>
          {stackedConsole ? <View style={styles.stacked}>{identity}<View style={styles.verifiedRow}>{verified}</View></View> : identity}
          {nav !== null && !wrapped ? <Nav items={nav} wrapped={false} group={group} /> : null}
          {me}
        </View>
        {navRow}
        {group !== null && group.open && !group.floating ? <MoreRow group={group} /> : null}
      </Wrap>
    </View>
  );
}

/** The slim footer every signed-in frame ends with (spec 15.1). */
export function Footer(props: { bottomInset: number }): React.JSX.Element {
  return (
    <View role="contentinfo" style={[styles.foot, { paddingBottom: props.bottomInset }]}>
      <Wrap>
        <View style={styles.footRow}>
          <Text style={styles.footText}>Townwise is a student project. It is not an official Dartmouth product.</Text>
          <View role="list" aria-label="Legal" style={styles.footLinks}>
            <View role="listitem"><Link href="/privacy" style={styles.footLink}>Privacy</Link></View>
            <View role="listitem"><Link href="/terms" style={styles.footLink}>Terms</Link></View>
          </View>
        </View>
      </Wrap>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  bar: { backgroundColor: c.ground, borderBottomWidth: 1, borderBottomColor: c.border },
  // While More's dropdown is open the bar is lifted over the page (every react-native-web View is its own stacking
  // context at z-index 0), so the box, which hangs below the bar, paints over main. Only then: a layer inside main,
  // such as TownwiseAI's file drop (z-index 9000 within main), must still cover the bar, and main's focus ring show.
  lifted: { zIndex: 1 },
  panel: { backgroundColor: c.panel },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 64, columnGap: 32 },
  identity: { flexDirection: 'row', alignItems: 'center', columnGap: 16, flexShrink: 1, minWidth: 0 },
  wordmark: { ...theme.type.wordmark, color: c.white, minHeight: 44, lineHeight: 44, textDecorationLine: 'none' },
  // StatusTag sets alignSelf: 'flex-start' for list rows; here it centers on the 44px wordmark.
  tagSlot: { alignSelf: 'center' },
  org: { flexDirection: 'row', alignItems: 'center', columnGap: 16, flexShrink: 1, minWidth: 0 },
  rule: { width: 1, height: 20, backgroundColor: c.border },
  orgName: { ...theme.type.ui, color: c.text2, flexShrink: 1 },
  nav: { flexDirection: 'row', flexWrap: 'wrap', flexShrink: 0 },
  // With a right-hand group the nav takes the row's free width, and the group sits at its far end.
  navSplit: { flexGrow: 1 },
  navEnd: { flexDirection: 'row', marginLeft: 'auto' },
  navLine: { flexWrap: 'nowrap', columnGap: 20 },
  scrollRegion: { marginHorizontal: -BLEED },
  scrollRow: { flexGrow: 1, paddingHorizontal: BLEED },
  navRow: { borderTopWidth: 1, borderTopColor: c.border },
  navLink: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  // More holds its dropdown, which paints over the nav's later items (Team, Settings).
  more: { zIndex: 1 },
  moreLabel: { flexDirection: 'row', alignItems: 'center', columnGap: 8 },
  // The select's drawn chevron (ui/Select.tsx), in the nav's colors; it points up while More is open.
  chevron: {
    width: 7, height: 7, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: c.text2, transform: [{ rotate: '45deg' }], marginTop: -4,
  },
  chevronLit: { borderColor: c.white },
  chevronOpen: { transform: [{ rotate: '-135deg' }], marginTop: 4 },
  // Under More, over the page: a square `panel` box with its links stacked, their text in line with More's.
  dropdown: {
    position: 'absolute', top: '100%', left: -16, marginTop: 4, minWidth: 176, paddingVertical: 8,
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.border,
  },
  boxLink: { paddingHorizontal: 16 },
  moreRow: { columnGap: 20 },
  navText: { ...theme.type.ui, color: c.text2 },
  white: { color: c.white },
  count: { fontFamily: theme.type.mono.fontFamily, fontVariant: ['tabular-nums'] },
  me: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', columnGap: 20, flexShrink: 1, minWidth: 0 },
  hold: { flexShrink: 0 },
  // 8px between the switch's square and Sign out, so the icon sits 20px from the words, as the email does.
  end: { flexDirection: 'row', alignItems: 'center', columnGap: 8, flexShrink: 0 },
  // The console on phones: the switch over Sign out, at the right edge.
  meStacked: { flexDirection: 'column', alignItems: 'flex-end' },
  status: { alignItems: 'flex-end', minWidth: 0, flexShrink: 1 },
  // The console on phones: the wordmark and kind tag, then “Verified until” in a 44px row level with Sign out. The
  // row holds its 44px with no time too: Sign out needs the second row anyway, and the band centers its two sides,
  // so without it the wordmark would sit halfway between the switch and Sign out.
  stacked: { flexShrink: 1, minWidth: 0 },
  verifiedRow: { minHeight: 44, justifyContent: 'center' },
  mail: { ...theme.type.mono, color: c.text3 },
  shrink: { flexShrink: 1 },
  tight: { columnGap: 12 },
  foot: { borderTopWidth: 1, borderTopColor: c.border },
  footRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 24, minHeight: 64 },
  footText: { ...theme.type.mono, color: c.text3 },
  footLinks: { flexDirection: 'row', columnGap: 24 },
  footLink: { ...theme.type.mono, color: c.text3, textDecorationLine: 'underline', textDecorationColor: c.line, minHeight: 44, lineHeight: 44 },
});
