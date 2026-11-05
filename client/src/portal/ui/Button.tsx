import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Link } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View, type PressableStateCallbackType } from 'react-native';

import { theme } from '../../theme';
import { webAria } from './aria';

// Buttons (spec 15.6, 15.7): one white primary per page with a dark label, outline buttons, and text links. Mint
// never fills a button. A disabled control keeps its place and its focus: it carries aria-disabled (never the
// disabled attribute), a `text3` label and a `border` outline, and pressing it does nothing. It is the same element
// enabled or disabled, so a button that turns disabled while its action runs (Save, Add, a dialog's primary) keeps
// keyboard focus. Nothing animates.

export type ButtonVariant = 'primary' | 'outline' | 'link';

interface CommonProps {
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** The accessible name when the visible label is not enough on its own ("Join Sample Restaurant Group"). */
  accessibilityLabel?: string;
  /** Ids of the lines that explain the control, such as the read-only line (web). */
  describedBy?: string;
  /** Full width, as End view-as on phones. */
  block?: boolean;
}

export interface ButtonProps extends CommonProps {
  onPress?: () => void;
}

// react-native-web reports hover in the press state; React Native's types do not declare it.
function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

function boxStyle(variant: ButtonVariant, state: PressableStateCallbackType, disabled: boolean, block: boolean) {
  return [
    styles[variant],
    !disabled && hovered(state) && hoverStyles[variant],
    disabled && disabledStyles[variant],
    disabled && styles.inert,
    block ? styles.block : styles.inline,
  ];
}

type Host = React.ComponentRef<typeof View>;

/** The two DOM calls the web disabled state needs; react-native-web hands the <button> itself to the ref. */
interface AttributeTarget {
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
}

/**
 * The disabled state on the same element. Native takes Pressable's `disabled` (accessibilityState, no touches). On
 * web react-native-web turns that prop into the disabled attribute and tabindex -1, which drop focus, so the button
 * gets no press handler and aria-disabled="true" is set on it directly.
 */
function useWebAriaDisabled(disabled: boolean): RefObject<Host | null> {
  const ref = useRef<Host>(null);
  useLayoutEffect(() => {
    if (Platform.OS !== 'web') return;
    const element = ref.current as unknown as AttributeTarget | null;
    if (disabled) element?.setAttribute('aria-disabled', 'true');
    else element?.removeAttribute('aria-disabled');
  }, [disabled]);
  return ref;
}

function Label(props: { variant: ButtonVariant; hover: boolean; disabled: boolean; text: string }): React.JSX.Element {
  const { variant, hover, disabled } = props;
  return (
    <Text style={[labelStyles[variant], !disabled && hover && labelHover[variant], disabled && labelDisabled[variant]]}>
      {props.text}
    </Text>
  );
}

export function Button(props: ButtonProps): React.JSX.Element {
  const variant = props.variant ?? 'primary';
  const disabled = props.disabled === true;
  const ref = useWebAriaDisabled(disabled);
  return (
    <Pressable
      ref={ref}
      role="button"
      {...(Platform.OS === 'web' ? {} : { disabled })}
      {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
      {...webAria({ 'aria-describedby': props.describedBy })}
      {...(disabled || props.onPress === undefined ? {} : { onPress: props.onPress })}
      style={(state) => boxStyle(variant, state, disabled, props.block === true)}
    >
      {(state) => <Label variant={variant} hover={hovered(state)} disabled={disabled} text={props.label} />}
    </Pressable>
  );
}

export interface LinkButtonProps extends CommonProps {
  href: string;
  /** Replaces the current history entry instead of adding one. */
  replace?: boolean;
}

/** A link that looks like a button or a text link. Disabled, it is a disabled button that goes nowhere. */
export function LinkButton(props: LinkButtonProps): React.JSX.Element {
  const variant = props.variant ?? 'link';
  if (props.disabled === true) return <Button {...props} variant={variant} />;
  return (
    <Link href={props.href} asChild {...(props.replace === true ? { replace: true } : {})}>
      <Pressable
        role="link"
        {...(props.accessibilityLabel === undefined ? {} : { accessibilityLabel: props.accessibilityLabel })}
        {...webAria({ 'aria-describedby': props.describedBy })}
        style={(state) => boxStyle(variant, state, false, props.block === true)}
      >
        {(state) => <Label variant={variant} hover={hovered(state)} disabled={false} text={props.label} />}
      </Pressable>
    </Link>
  );
}

/** A row of actions, wrapping, 12px by 20px apart (`.acts`). */
export function Actions(props: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.actions}>{props.children}</View>;
}

const c = theme.color;

const styles = StyleSheet.create({
  primary: { minHeight: 44, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: c.cta, borderRadius: 0 },
  outline: {
    minHeight: 44, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.line,
    borderRadius: 0, backgroundColor: 'transparent',
  },
  link: { minHeight: 44, minWidth: 44, alignItems: 'flex-start', justifyContent: 'center' },
  inline: { alignSelf: 'flex-start' },
  block: { alignSelf: 'stretch' },
  /** No pointer cursor on a control that does nothing. */
  inert: { cursor: 'auto' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 20, rowGap: 12 },
});

const hoverStyles = StyleSheet.create({
  primary: { backgroundColor: c.ctaHover },
  outline: { borderColor: c.white },
  link: {},
});

const disabledStyles = StyleSheet.create({
  primary: { backgroundColor: c.raised, borderWidth: 1, borderColor: c.border, paddingHorizontal: 17 },
  outline: { borderColor: c.border },
  link: {},
});

const labelStyles = StyleSheet.create({
  primary: { ...theme.type.button, color: c.onCta },
  outline: { ...theme.type.ui, color: c.white, textAlign: 'center' },
  link: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
});

const labelHover = StyleSheet.create({
  primary: {},
  outline: {},
  link: { color: c.mint, textDecorationColor: c.mint },
});

const labelDisabled = StyleSheet.create({
  primary: { color: c.text3 },
  outline: { color: c.text3 },
  link: { color: c.text3, textDecorationColor: c.border },
});
