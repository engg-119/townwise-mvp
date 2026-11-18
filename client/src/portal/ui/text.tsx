import { Platform, StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { webAria } from './aria';
import { useFocusFallback } from './messageFocus';

// The portal's type (spec 15.6): Instrument Sans for reading and UI, Geist Mono for labels and every numeral.
// Sizes step down at 1023px and 640px as the shell's CSS does.

/**
 * The box of a link inside a sentence (“Questions: {address}.”, “Leave {org}.”, Sign out in the signed-in line).
 * On web its 18 to 20px of text gains 13px above and below, a tap target of at least 44px, and the line does not
 * move, since an inline element's padding takes no room. Native's nested text takes no padding.
 */
export const inlineTarget: TextStyle = Platform.OS === 'web' ? { paddingVertical: 13 } : {};

interface TextProps {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  nativeID?: string;
}

/** The mono, uppercase kicker above a title (`tw-eyebrow`). */
export function Eyebrow(props: TextProps): React.JSX.Element {
  return <Text nativeID={props.nativeID} style={[styles.eyebrow, props.style]}>{props.children}</Text>;
}

/**
 * The page's one h1, styled `tw-h2`: 40/44, then 32/36 below 1024px, then 28/32 at 640px and below. `lines` caps it
 * and ends it with an ellipsis (the chat's compact header on phones). Inside a MessageFocus it can take focus
 * (`tabIndex` -1), which it does when an action took away the control that had it and said so in a toast.
 */
export function Title(props: TextProps & { lines?: number }): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const size = phone ? theme.type.h2Phone : desktop ? theme.type.h2 : theme.type.h2Tablet;
  // Inside a MessageFocus the h1 takes focus in place of a notice shown as a toast (ui/messageFocus.tsx).
  const fallback = useFocusFallback<React.ComponentRef<typeof Text>>();
  return (
    <Text
      role="heading"
      {...fallback}
      {...webAria({ 'aria-level': 1 })}
      nativeID={props.nativeID}
      {...(props.lines === undefined ? {} : { numberOfLines: props.lines })}
      style={[size, styles.white, props.style]}
    >
      {props.children}
    </Text>
  );
}

/** A section heading (h2, h3, or h4 under an h3), styled `tw-h3` unless `big`. */
export function Heading(props: TextProps & { level?: 2 | 3 | 4; big?: boolean }): React.JSX.Element {
  const { phone, desktop } = useBreakpoint();
  const size = props.big === true
    ? (phone ? theme.type.h2Phone : desktop ? theme.type.h2 : theme.type.h2Tablet)
    : (phone ? theme.type.h3Phone : theme.type.h3);
  return (
    <Text role="heading" {...webAria({ 'aria-level': props.level ?? 2 })} nativeID={props.nativeID} style={[size, styles.white, props.style]}>
      {props.children}
    </Text>
  );
}

/** Reading text: 17/28, 16/24 on phones, in `text2`. */
export function Body(props: TextProps): React.JSX.Element {
  const { phone } = useBreakpoint();
  return <Text nativeID={props.nativeID} style={[phone ? theme.type.bodyPhone : theme.type.body, styles.text2, props.style]}>{props.children}</Text>;
}

/** The lead under a page title (`sub`). */
export function Lead(props: TextProps): React.JSX.Element {
  return <Text nativeID={props.nativeID} style={[theme.type.sub, styles.text2, props.style]}>{props.children}</Text>;
}

/** 14/20 in `text2`; 16/24 on phones, where the shell sets small running text at body size. */
export function Small(props: TextProps & { white?: boolean }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <Text nativeID={props.nativeID} style={[phone ? theme.type.sub : theme.type.small, props.white === true ? styles.white : styles.text2, props.style]}>
      {props.children}
    </Text>
  );
}

/** Mono 12/16 with tabular figures, for numerals, labels and fine print. */
export function Mono(props: TextProps & { tone?: 'text2' | 'text3' | 'white' }): React.JSX.Element {
  const tone = props.tone === 'white' ? styles.white : props.tone === 'text3' ? styles.text3 : styles.text2;
  return <Text nativeID={props.nativeID} style={[theme.type.mono, styles.tabular, tone, props.style]}>{props.children}</Text>;
}

const styles = StyleSheet.create({
  eyebrow: { ...theme.type.label, color: theme.color.text3 },
  white: { color: theme.color.white },
  text2: { color: theme.color.text2 },
  text3: { color: theme.color.text3 },
  tabular: { fontVariant: ['tabular-nums'] },
});
