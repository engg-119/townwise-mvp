import { Link, useRouter } from 'expo-router';
import { useLayoutEffect, useRef } from 'react';
import { Image, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { theme } from '../../theme';
import { sourceChips, type Chip, type ChipSource } from '../sources/site';

// The source chip (refine-calendar-and-home design decision 6, spec D40), one file for web and native: every link to a
// source in the portal and TownwiseAI is a pill with the site's logo and name (sources/site.ts), never cut. The pill is
// at least 24px tall, round at that height (a pill whose name wraps keeps 12px corners), a `raised` fill with a 1px
// `border` outline, 8px side padding, the logo in a 16px circle on `logoGround` (or the globe in `text3` for a site
// with no committed logo), 6px, then the name in 12px sans `text2`. The link is the 44px target around it, the pill
// centered in it, with no hitSlop: in a row (SourceChips) the pills sit 8px apart across and a wrapped row's 20px below
// (44 less 24), so no two targets overlap. A chip moves to the next line whole; only one wider than its whole row wraps
// its name inside the pill. The logo is decoration; the link's name starts with what it shows ("Dartmouth Registrar 2.
// Source: …"), and on web the source's label is the link's title. Logos are committed same-origin assets, so nothing
// here loads from another site. On web the chip is an <a href>; on native a press opens the link with Linking.
// AppChip is the in-app mode (D49, calendar-sources): the same pill to a page inside the app (a calendar's page or a
// file's item in Your data), with a calendar or file glyph in the logo's place, navigating with expo-router (`Link` on
// web, so the page never reloads, and `router.push` on native, where Linking cannot open an app path). It only ever
// holds an app path, never a calendar's address.

/** The DOM call the title needs; react-native-web hands the <a> itself to the ref. */
interface AttributeTarget {
  setAttribute: (name: string, value: string) => void;
}

/** Where the link opens on web, passed to the <a> as it is (TownwiseAI's open in a new tab with noopener). */
export interface ChipLink {
  target?: '_blank' | undefined;
  rel?: string | undefined;
}

/** The plain globe for a site with no committed logo: Lucide's globe (ISC license, lucide.dev), in text3. */
function Globe(): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.text3} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20" />
      <Path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <Path d="M2 12h20" />
    </Svg>
  );
}

/** Lucide's calendar (ISC license, lucide.dev), in text3. */
function CalendarGlyph(): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.text3} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M8 2v4" />
      <Path d="M16 2v4" />
      <Path d="M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2" />
      <Path d="M3 10h18" />
    </Svg>
  );
}

/** Lucide's file (ISC license, lucide.dev), in text3. */
function FileGlyph(): React.JSX.Element {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.text3} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <Path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </Svg>
  );
}

/** The link's own props: an <a href> on web (with its target and rel), a press that opens it on native. */
function linkProps(url: string, link: ChipLink): object {
  if (Platform.OS !== 'web') return { onPress: () => { void Linking.openURL(url).catch(() => undefined); } };
  const hrefAttrs = Object.fromEntries(Object.entries({ target: link.target, rel: link.rel }).filter(([, value]) => value !== undefined));
  return Object.keys(hrefAttrs).length === 0 ? { href: url } : { href: url, hrefAttrs };
}

/** One source chip. */
export function SourceChip(props: { chip: Chip } & ChipLink): React.JSX.Element {
  const { chip } = props;
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  // react-native-web passes no title prop through, so the label goes on the <a> itself, as Button sets aria-disabled.
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    (ref.current as unknown as AttributeTarget | null)?.setAttribute('title', chip.title);
  }, [chip.title]);
  return (
    <Pressable ref={ref} role="link" accessibilityLabel={chip.name} {...linkProps(chip.url, props)} style={styles.target}>
      <View style={styles.pill}>
        <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={chip.logo === null ? styles.globe : styles.logo}>
          {chip.logo === null ? <Globe /> : <Image source={chip.logo} style={styles.image} />}
        </View>
        <Text style={styles.name}>{chip.shown}</Text>
      </View>
    </Pressable>
  );
}

/**
 * A chip to a page inside the app: `name` is what it shows, `label` its accessible name, starting with `name`.
 */
export function AppChip(props: { href: string; name: string; label: string; glyph: 'calendar' | 'file' }): React.JSX.Element {
  const router = useRouter();
  const pill = (
    <View style={styles.pill}>
      <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.globe}>
        {props.glyph === 'calendar' ? <CalendarGlyph /> : <FileGlyph />}
      </View>
      <Text style={styles.name}>{props.name}</Text>
    </View>
  );
  if (Platform.OS === 'web') {
    return (
      <Link href={props.href} asChild>
        {/* A child of Link asChild takes one plain style object (ui/hover.ts). */}
        <Pressable role="link" accessibilityLabel={props.label} style={styles.appTarget}>
          {pill}
        </Pressable>
      </Link>
    );
  }
  return (
    <Pressable role="link" accessibilityLabel={props.label} onPress={() => { router.push(props.href); }} style={styles.appTarget}>
      {pill}
    </Pressable>
  );
}

/** A row of source chips, numbering repeats of one site (sources/site.ts); nothing for no sources. */
export function SourceChips(props: { sources: readonly ChipSource[] } & ChipLink): React.JSX.Element | null {
  if (props.sources.length === 0) return null;
  return (
    <View style={styles.row}>
      {sourceChips(props.sources).map((chip, index) => (
        <SourceChip key={`${String(index)} ${chip.url}`} chip={chip} target={props.target} rel={props.rel} />
      ))}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 0, minWidth: 0 },
  target: { minHeight: 44, justifyContent: 'center', maxWidth: '100%' },
  // An in-app chip sits alone in a column, which would stretch it across the panel: it hugs its pill (UI review S1).
  appTarget: { minHeight: 44, justifyContent: 'center', maxWidth: '100%', alignSelf: 'flex-start' },
  pill: {
    flexDirection: 'row', alignItems: 'center', columnGap: 6, minHeight: 24, maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.raised,
  },
  logo: { width: 16, height: 16, borderRadius: 8, overflow: 'hidden', backgroundColor: c.logoGround },
  globe: { width: 16, height: 16 },
  image: { width: 16, height: 16 },
  name: { fontFamily: theme.type.small.fontFamily, fontSize: 12, lineHeight: 16, fontWeight: 400, color: c.text2, flexShrink: 1, minWidth: 0 },
});
