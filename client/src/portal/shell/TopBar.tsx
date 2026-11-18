import { useCallback, useEffect, useId, useState } from 'react';
import { Link, usePathname } from 'expo-router';
import {
  Animated, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type PressableStateCallbackType,
} from 'react-native';

import { useReducedMotion } from '../../motion';
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
// Below 900px (1024px in the console, 1280px when the client app's bar carries a location's sections, which need
// the room) the nav links take a second row under a rule. At 640px and below the email hides and the organization
// name truncates; the console's bar is one band of two 44px rows and the nav: the wordmark, kind tag and switch, then
// “Verified until” and Sign out (the wordmark, kind tag, switch and Sign out are too wide for one 320px row).
// The client app's Notes, Rules, Town and Your data sit under More (D38), a disclosure where the first of them was:
// on web its links drop down under it in a `panel` box over the page; on native they take a row under the bar.
// At 640px and below the client app's bar has no nav row (D51): a Menu button after the switch, two lines that
// close into an X, opens one panel under the bar with every link, one to a row, and Sign out last.

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

function NavLink(props: { item: NavItem; inBox?: boolean; onPress?: () => void }): React.JSX.Element {
  const { item } = props;
  const current = item.current !== null;
  return (
    <Link href={item.href} asChild {...(props.onPress === undefined || Platform.OS === 'web' ? {} : { onPress: props.onPress })}>
      <Pressable
        role="link"
        accessibilityState={{ selected: current }}
        {...webAria({ 'aria-current': item.current ?? undefined })}
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
  /** On web the links drop down under More, inside the nav; on native the bar draws them in a row under it. */
  floating: boolean;
  /** The links' container, named by aria-controls while open; More's button and box take ids built from it (moreIds). */
  id: string;
  onToggle: () => void;
}

/** The ids of More's button, where Escape returns focus, and its box: More and, when floating, its links. */
function moreIds(id: string): { button: string; box: string } {
  return { button: `${id}-button`, box: `${id}-box` };
}

/**
 * More: a disclosure over the grouped sections, white while open, hovered or holding the current page, with the
 * select's drawn chevron, which turns up while open.
 */
function More(props: { group: MoreGroup }): React.JSX.Element {
  const { group } = props;
  const holdsCurrent = group.items.some((item) => item.current !== null);
  return (
    <View nativeID={moreIds(group.id).box} style={styles.more}>
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
function entries(items: readonly NavItem[], group: MoreGroup | null): React.JSX.Element[] {
  const first = items.findIndex((item) => item.more === true);
  return items.flatMap((item, index) => {
    if (item.more !== true || group === null) return [<NavLink key={item.href} item={item} />];
    return index === first ? [<More key="more" group={group} />] : [];
  });
}

/**
 * The nav, with the items from the first `end` one on as a group at the row's far end. Links sit `space-6` (24px)
 * apart, or `space-5` (20px) in the second row and in the client app's one-row bar with a location's sections, so
 * from 1280px the organization name and the email keep their room (D38).
 */
function Nav(props: { items: readonly NavItem[]; wrapped: boolean; sections?: boolean; group: MoreGroup | null }): React.JSX.Element {
  const gap = { columnGap: props.wrapped || props.sections === true ? 20 : 24 };
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
 * More's links in a row under the bar (native), a navigation of their own, as Android delivers no touch outside a
 * view's box. In the flow it covers nothing, so it stays open until More or another page closes it.
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
 * On web, Escape with focus on More (or the phone's Menu button) or one of its links closes it and hands focus back
 * to the button (an Escape meant for anything else on the page is left alone). The dropdown or panel, which covers
 * the page, also closes on a press or focus outside the button and its links, leaving focus where it went. Native
 * closes it when the button is pressed again or the page changes. react-native-web renders nativeID as the element's
 * id, so the elements are found by id.
 */
function useDismiss(open: boolean, floating: boolean, id: string, close: () => void, onLink: boolean): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || !open) return undefined;
    const { box, button } = moreIds(id);
    const inside = (target: EventTarget | null): boolean => target instanceof Node
      && [box, button, id].some((part) => document.getElementById(part)?.contains(target) === true);
    const onOutside = (event: Event): void => { if (!inside(event.target)) close(); };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !inside(document.activeElement)) return;
      close();
      document.getElementById(button)?.focus();
    };
    // The phone menu closes on a press of one of its links, the current page's too, and hands focus to Menu, as the
    // link is about to leave. In the capture phase, as react-native-web's Pressable stops a click from bubbling.
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Element) || event.target.closest('a') === null) return;
      if (document.getElementById(id)?.contains(event.target) !== true) return;
      close();
      document.getElementById(button)?.focus();
    };
    document.addEventListener('keydown', onKey);
    if (onLink) document.addEventListener('click', onClick, true);
    if (floating) {
      document.addEventListener('pointerdown', onOutside);
      document.addEventListener('focusin', onOutside);
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('focusin', onOutside);
    };
  }, [open, floating, id, close, onLink]);
}

/** The phone menu's ease, for each step of its motion: a soft start and a soft stop. */
const EASE = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * `values` at evenly spaced stops of the menu's value (two for the whole motion, three for its two halves), as an
 * interpolation that eases each stretch between them. The curve is sampled into the ranges, as the native driver
 * interpolates in straight lines only.
 */
function eased(values: readonly number[]): { inputRange: number[]; outputRange: number[] } {
  const STEPS = 12;
  const spans = values.length - 1;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  for (let span = 0; span < spans; span += 1) {
    const from = values[span] ?? 0;
    const to = values[span + 1] ?? 0;
    for (let step = span === 0 ? 0 : 1; step <= STEPS; step += 1) {
      inputRange.push((span + step / STEPS) / spans);
      outputRange.push(from + (to - from) * EASE(step / STEPS));
    }
  }
  return { inputRange, outputRange };
}

/**
 * The phone menu's motion (D51): one value, 0 closed and 1 open, moving at an even pace, that the button's lines and
 * the panel both follow, so they move as one; each eases its own steps (`eased`). The panel stays mounted while it
 * closes, until the value is back at 0. With Reduce Motion on (or not yet known) the change is immediate.
 */
function useMenuMotion(open: boolean): { progress: Animated.Value; mounted: boolean } {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(open ? 1 : 0));
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const duration = reduced === false ? 280 : 0;
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: open ? 1 : 0, duration, easing: (t) => t, useNativeDriver: Platform.OS !== 'web' });
    animation.start(({ finished }) => { if (finished && !open) setMounted(false); });
    return () => { animation.stop(); };
  }, [open, duration, progress]);
  return { progress, mounted };
}

/**
 * One of the Menu button's two lines. Both are the same 20px by 2px box at the icon's center, drawn 4px above
 * (`side` -1) or below it (1) while closed. Opening, a line slides to the center in the first half of the motion,
 * then turns 45 degrees its own way in the second, so the two cross at their midpoints; closing runs the same path
 * back, each half as long as the other.
 */
function menuLine(progress: Animated.Value, side: 1 | -1): React.JSX.Element {
  const translateY = progress.interpolate(eased([side * 4, 0, 0]));
  const turn = eased([0, 0, side * -45]);
  const rotate = progress.interpolate({ inputRange: turn.inputRange, outputRange: turn.outputRange.map((degrees) => `${String(degrees)}deg`) });
  return <Animated.View style={[styles.menuLine, { transform: [{ translateY }, { rotate }] }]} />;
}

/** The phone's Menu button (D51): a 44px square after the light and dark switch, named “Menu” open or closed. */
function MenuButton(props: { id: string; open: boolean; progress: Animated.Value; onToggle: () => void }): React.JSX.Element {
  return (
    <Pressable
      nativeID={moreIds(props.id).button}
      role="button"
      accessibilityLabel="Menu"
      aria-expanded={props.open}
      {...(props.open ? { 'aria-controls': props.id } : {})}
      accessibilityState={{ expanded: props.open }}
      onPress={props.onToggle}
      style={(state) => [styles.menuButton, hovered(state) ? styles.menuHover : null]}
    >
      <View style={styles.menuIcon}>
        {menuLine(props.progress, -1)}
        {menuLine(props.progress, 1)}
      </View>
    </Pressable>
  );
}

/**
 * The phone menu's panel (D51): every link of the nav, one to a 44px row, in groups under rules (the sections, the
 * ones the wider bar keeps under More, then Team and Settings), and Sign out last. On web it hangs under the bar,
 * over the page; on native it is in the flow, as Android delivers no touch outside a view's box. It scrolls inside
 * itself on a short screen. Its box clips it, so as it drops it comes out from under the bar, never over the bar's
 * rule. While it closes it is still drawn, but takes no press and is hidden from assistive tech. A press on a link
 * closes it, the current page's too, which moves nowhere (on web through useDismiss, as expo-router's Link takes no
 * press handler of ours there).
 */
function Menu(props: {
  id: string; items: readonly NavItem[]; open: boolean; over: boolean; progress: Animated.Value; signOut: React.ReactNode;
  onLink: () => void;
}): React.JSX.Element {
  const { height } = useWindowDimensions();
  const split = props.items.findIndex((item) => item.end === true);
  const head = split < 0 ? props.items : props.items.slice(0, split);
  const groups = [
    head.filter((item) => item.more !== true), head.filter((item) => item.more === true), split < 0 ? [] : props.items.slice(split),
  ].filter((group) => group.length > 0);
  const opacity = props.progress.interpolate(eased([0, 1]));
  const translateY = props.progress.interpolate(eased([-8, 0]));
  return (
    <View
      nativeID={props.id}
      aria-hidden={!props.open}
      style={[styles.menuBox, props.over ? styles.menuOver : null, props.open ? null : styles.menuClosing]}
    >
    <Animated.View style={[styles.menu, props.over ? styles.menuEdge : null, { opacity, transform: [{ translateY }] }]}>
      <ScrollView nestedScrollEnabled style={{ maxHeight: Math.max(240, height - 160) }}>
        <Wrap>
          <View role="navigation" aria-label="Main">
            {groups.map((group, index) => (
              <View key={group[0]?.href} style={[styles.menuGroup, index > 0 ? styles.menuRule : null]}>
                {group.map((item) => <NavLink key={item.href} item={item} onPress={props.onLink} />)}
              </View>
            ))}
          </View>
          <View style={[styles.menuGroup, styles.menuRule, styles.menuEnd]}>{props.signOut}</View>
        </Wrap>
      </ScrollView>
    </Animated.View>
    </View>
  );
}

export function TopBar(props: TopBarProps): React.JSX.Element {
  const { phone, width } = useBreakpoint();
  const consoleBar = props.kind === 'console';
  const sections = (props.nav ?? []).findIndex((item) => item.end === true) > 0;
  const nav = props.nav === undefined || props.nav.length === 0 ? null : props.nav;
  // The phone's menu (D51) takes the place of the nav row, More and the bar's Sign out.
  const menu = phone && props.kind === 'client' && nav !== null;
  // More, or the menu, opened on one page reads as closed on any other: it holds the path and nav it was opened on, so following a
  // link, the location switcher or any other move closes it without an effect. The path counts on its own, since
  // pages such as Location settings and Locations draw the same nav.
  const pathname = usePathname();
  const where = [menu ? 'menu' : 'bar', pathname, ...(props.nav ?? []).map((item) => `${item.href} ${item.current ?? ''}`)].join('\n');
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === where;
  // Once it reads as closed it is closed: coming back to that page or width does not open it again.
  if (openOn !== null && !open) setOpenOn(null);
  const moreId = `more-${useId().replace(/:/g, '')}`;
  const close = useCallback(() => { setOpenOn(null); }, []);
  const grouped = menu ? [] : (props.nav ?? []).filter((item) => item.more === true);
  const floating = Platform.OS === 'web';
  useDismiss(open && (menu || grouped.length > 0), floating, moreId, close, menu);
  const motion = useMenuMotion(menu && open);
  const group: MoreGroup | null = grouped.length === 0 ? null : {
    items: grouped,
    open,
    floating,
    id: moreId,
    onToggle: () => { setOpenOn(open ? null : where); },
  };
  const wrapped = width < (consoleBar ? 1024 : sections ? 1280 : 900);
  const home = consoleBar ? '/admin/overview' : '/dashboard';
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
  if (menu) {
    // Only the switch and the Menu button, which never shrink; Sign out is the menu's last row.
    me = (
      <View style={[styles.me, styles.hold]}>
        <View style={styles.end}>
          <ThemeToggle />
          <MenuButton id={moreId} open={open} progress={motion.progress} onToggle={() => { setOpenOn(open ? null : where); }} />
        </View>
      </View>
    );
  } else if (stackedConsole) {
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
  const navRow = nav !== null && wrapped && !menu ? <View style={styles.navRow}><Nav items={nav} wrapped group={group} /></View> : null;
  const lifted = menu ? floating && motion.mounted : group?.floating === true && group.open;
  return (
    <View role="banner" style={[styles.bar, consoleBar ? styles.panel : null, lifted ? styles.lifted : null]}>
      <Wrap>
        <View style={[styles.row, tight]}>
          {stackedConsole ? <View style={styles.stacked}>{identity}<View style={styles.verifiedRow}>{verified}</View></View> : identity}
          {nav !== null && !wrapped ? <Nav items={nav} wrapped={false} sections={sections} group={group} /> : null}
          {me}
        </View>
        {navRow}
        {group !== null && group.open && !group.floating ? <MoreRow group={group} /> : null}
      </Wrap>
      {menu && motion.mounted ? <Menu id={moreId} items={nav} open={open} over={floating} progress={motion.progress} signOut={signOut} onLink={close} /> : null}
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
  // While More's dropdown (or the phone's menu) is open the bar is lifted over the page (every react-native-web View is its own stacking
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
  // The phone's Menu button (D51): the switch's 44px square and hover. Its two lines share one box at the center.
  menuButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  menuHover: { backgroundColor: c.raised },
  menuIcon: { width: 20, height: 20 },
  menuLine: { position: 'absolute', left: 0, top: 9, width: 20, height: 2, borderRadius: 1, backgroundColor: c.white },
  // The menu's panel: `panel` under a rule. Over the page (web) it starts on the bar's own rule and ends with one.
  menuBox: { overflow: 'hidden' },
  menu: { backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.border },
  menuOver: { position: 'absolute', top: '100%', left: 0, right: 0 },
  menuEdge: { borderBottomWidth: 1, borderBottomColor: c.border },
  menuClosing: { pointerEvents: 'none' },
  menuGroup: { paddingVertical: 8 },
  menuRule: { borderTopWidth: 1, borderTopColor: c.border },
  menuEnd: { alignItems: 'flex-start' },
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
