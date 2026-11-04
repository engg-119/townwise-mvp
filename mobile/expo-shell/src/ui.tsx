import { useEffect, useRef, useState } from 'react';
import { Link, type Href } from 'expo-router';
import {
  AccessibilityInfo, ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View,
  type PressableStateCallbackType, type TextInputProps,
} from 'react-native';

import { ApiError } from './api/client';
import { theme } from './theme';

// The app screens in the design system's colors and type: the dark ground, white primary buttons,
// text-link secondary actions and a left-aligned column with the grid's page margins.
export function Screen(props: { children: React.ReactNode; scroll?: boolean }): React.JSX.Element {
  const { width } = useWindowDimensions();
  const margin = width <= 640 ? theme.space.marginPhone : width <= 1023 ? theme.space.marginTablet : theme.space.marginWide;
  const column = [styles.column, { marginHorizontal: margin, paddingVertical: width <= 640 ? theme.space[6] : theme.space[12] }];
  if (props.scroll === true) {
    // Taps reach the buttons while the keyboard is up, as they do without a scroll view.
    return (
      <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled">
        <View style={column}>{props.children}</View>
      </ScrollView>
    );
  }
  return (
    <View style={styles.screen}>
      <View style={[column, styles.fill]}>{props.children}</View>
    </View>
  );
}

export function Button(props: { label: string; onPress: () => void; disabled?: boolean; variant?: 'link' }): React.JSX.Element {
  const link = props.variant === 'link';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
      style={(state) => [
        link ? styles.linkButton : styles.button,
        !link && hovered(state) && styles.buttonHover,
        !link && state.pressed && styles.buttonPressed,
        props.disabled === true && styles.disabled,
      ]}
    >
      {(state) => (
        <Text style={[link ? styles.link : styles.buttonLabel, link && hovered(state) && styles.linkHover]}>{props.label}</Text>
      )}
    </Pressable>
  );
}

// react-native-web reports hover in the press state; React Native's types do not declare it.
function hovered(state: PressableStateCallbackType): boolean {
  return (state as { hovered?: boolean }).hovered === true;
}

export function TextLink(props: { href: Href; children: string }): React.JSX.Element {
  return <Link href={props.href} style={[styles.link, styles.linkBox]}>{props.children}</Link>;
}

export function Field(props: TextInputProps & { label: string }): React.JSX.Element {
  const { label, style, ...rest } = props;
  return (
    <View style={styles.fieldBox}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} autoCapitalize="none" {...rest} style={[style, styles.field]} />
    </View>
  );
}

// An error arrives after a press, away from where focus is, so it is announced: the alert role on web,
// the live region on Android, and an announcement on iOS, which reads neither when content appears.
export function Message(props: { tone?: 'info' | 'error'; children: React.ReactNode }): React.JSX.Element {
  const alert = props.tone === 'error';
  const text = typeof props.children === 'string' ? props.children : null;
  useEffect(() => {
    if (alert && text !== null && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [alert, text]);
  return (
    <Text role={alert ? 'alert' : undefined} aria-live={alert ? 'assertive' : undefined} style={styles.message}>
      {props.children}
    </Text>
  );
}

export function Loading(): React.JSX.Element {
  return (
    <View style={[styles.screen, styles.center]}>
      <ActivityIndicator aria-label="Loading" color={theme.color.text2} />
    </View>
  );
}

export function Unreachable(props: { onRetry: () => Promise<void>; onSignInAgain?: () => Promise<void> }): React.JSX.Element {
  const signInAgain = props.onSignInAgain;
  return (
    <Screen>
      <Message>{"Can't reach the server."}</Message>
      <Button label="Retry" onPress={() => { void props.onRetry(); }} />
      {signInAgain === undefined ? null : <Button variant="link" label="Sign in again" onPress={() => { void signInAgain(); }} />}
    </Screen>
  );
}

export function useSubmit<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): { submit: (...args: A) => void; pending: boolean; error: string | null } {
  const inflight = useRef(false);
  const actionRef = useRef(action);
  useEffect(() => {
    actionRef.current = action;
  }, [action]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(...args: A): void {
    if (inflight.current) return;
    inflight.current = true;
    setPending(true);
    setError(null);
    void actionRef.current(...args).then(
      () => {
        inflight.current = false;
        setPending(false);
      },
      (caught: unknown) => {
        inflight.current = false;
        setPending(false);
        setError(describeError(caught));
      },
    );
  }

  return { submit, pending, error };
}

export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Something went wrong.';
  if (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && error.status === 503)) {
    return "Can't reach the server.";
  }
  if (error.kind === 'http' && error.status === 429) {
    if (error.retryAfterSeconds === null) return 'Too many attempts. Try again later.';
    const minutes = Math.ceil(error.retryAfterSeconds / 60);
    return `Too many attempts. Try again in ${String(minutes)} minutes.`;
  }
  return 'Something went wrong.';
}

const c = theme.color;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.ground },
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  column: { maxWidth: 480, gap: theme.space[4] },
  button: { minHeight: 44, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: c.cta },
  buttonHover: { backgroundColor: c.ctaHover },
  buttonPressed: { transform: [{ scale: 0.97 }] },
  buttonLabel: { ...theme.type.button, color: c.onCta },
  disabled: { opacity: 0.5 },
  linkButton: { alignSelf: 'flex-start', minHeight: 44, minWidth: 44, justifyContent: 'center' },
  link: { ...theme.type.ui, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  linkHover: { color: c.mint, textDecorationColor: c.mint },
  linkBox: { alignSelf: 'flex-start', paddingVertical: 12 },
  fieldBox: { gap: theme.space[2] },
  label: { ...theme.type.ui, color: c.white },
  field: { ...theme.type.code, minHeight: 44, paddingHorizontal: 12, color: c.white, backgroundColor: c.ground, borderWidth: 1, borderColor: c.line, borderRadius: 0 },
  message: { ...theme.type.sub, color: c.white },
});
