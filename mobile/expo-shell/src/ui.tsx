import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { ApiError } from './api/client';

export function Screen(props: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.screen}>{props.children}</View>;
}

export function Button(props: { label: string; onPress: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
    >
      <Text>{props.label}</Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }): React.JSX.Element {
  const { label, style, ...rest } = props;
  return (
    <View>
      <Text>{label}</Text>
      <TextInput accessibilityLabel={label} autoCapitalize="none" {...rest} style={[style, styles.field]} />
    </View>
  );
}

export function Message(props: { tone?: 'info' | 'error'; children: React.ReactNode }): React.JSX.Element {
  return <Text>{props.children}</Text>;
}

export function Loading(): React.JSX.Element {
  return <ActivityIndicator aria-label="Loading" />;
}

export function Unreachable(props: { onRetry: () => Promise<void>; onSignInAgain?: () => Promise<void> }): React.JSX.Element {
  const signInAgain = props.onSignInAgain;
  return (
    <Screen>
      <Message>{"Can't reach the server."}</Message>
      <Button label="Retry" onPress={() => { void props.onRetry(); }} />
      {signInAgain === undefined ? null : <Button label="Sign in again" onPress={() => { void signInAgain(); }} />}
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
    if (error.retryAfterSeconds === null) return 'Try again later.';
    const minutes = Math.ceil(error.retryAfterSeconds / 60);
    return `Too many attempts. Try again in ${String(minutes)} minutes.`;
  }
  return 'Something went wrong.';
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, gap: 12 },
  field: { fontSize: 16 },
});
