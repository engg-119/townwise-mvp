import { useEffect, useState } from 'react';
import { Link, Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { Platform } from 'react-native';

import { ApiError } from '../../src/api/client';
import { useAuth, useAuthState } from '../../src/auth/AuthProvider';
import { parseMagicFragment } from '../../src/auth/magicLink';
import { routeFor } from '../../src/auth/store';
import { Button, Message, Screen, useSubmit } from '../../src/ui';

const EXPIRED = 'Links work once, for 15 minutes, on the device where you asked for them. Request a new one.';

export default function MagicLinkScreen(): React.JSX.Element | null {
  const params = useLocalSearchParams<{ '#'?: string }>();
  const [link] = useState(() => parseMagicFragment(hashParam(params['#'])));
  const router = useRouter();
  const auth = useAuth();
  const state = useAuthState();
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    function clearHash(): void {
      if (cancelled) return;
      router.setParams({ '#': undefined });
      if (Platform.OS !== 'web' || window.location.hash === '' || tries >= 20) return;
      tries += 1;
      timer = setTimeout(clearHash, 0);
    }
    if (Platform.OS === 'web') timer = setTimeout(clearHash, 0);
    else queueMicrotask(clearHash);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [router]);

  const { submit, pending } = useSubmit(async () => {
    if (link === null) return;
    try {
      await auth.redeemMagicLink(link);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_or_expired_link') setExpired(true);
    }
  });

  if (state.status === 'signedIn' || state.status === 'mfaRequired') {
    const href = routeFor(state);
    if (href !== null) return <Redirect href={href} />;
  }

  if (expired) {
    return (
      <Screen>
        <Message>{EXPIRED}</Message>
        <Link href="/sign-in">Go to sign in</Link>
      </Screen>
    );
  }

  if (link === null) {
    return (
      <Screen>
        <Message>This link is invalid or incomplete</Message>
        <Link href="/sign-in">Go to sign in</Link>
      </Screen>
    );
  }

  return (
    <Screen>
      <Message>{`Sign in as ${link.email}?`}</Message>
      <Button label="Continue" onPress={() => { submit(); }} {...(pending ? { disabled: true } : {})} />
      <Link href="/sign-in">Not you? Go to sign in</Link>
    </Screen>
  );
}

function hashParam(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
