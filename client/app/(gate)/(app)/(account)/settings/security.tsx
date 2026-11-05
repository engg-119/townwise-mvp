import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image, Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../../../../src/api/client';
import { normalizeTotpCode, type Me } from '../../../../../src/auth/auth';
import { useAuth } from '../../../../../src/auth/AuthProvider';
import { useOptionalPortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { Notice } from '../../../../../src/portal/ui/feedback';
import { theme } from '../../../../../src/theme';
import { Button, describeError, Field, Message, useSubmit } from '../../../../../src/ui';

const INVALID_CODE = "That code didn't work. Codes change every 30 seconds; wait for a new one and try again.";

// P7 (spec 16.2, F9): staff in staff_setup_required land here with this notice, and after the recovery codes
// sign in again, so the next session passes a code.
const STAFF_SETUP_NOTICE = 'Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.';

export default function SecurityScreen(): React.JSX.Element {
  const auth = useAuth();
  const staffSetup = useOptionalPortal()?.me.access.state === 'staff_setup_required';
  const [me, setMe] = useState<Me | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [othersSignedOut, setOthersSignedOut] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    void auth.loadMe().then((next) => {
      if (!cancelled) setMe(next);
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(describeError(error));
    });
    return () => { cancelled = true; };
  }, [auth]);

  useFocusEffect(load);

  const enroll = useSubmit(async () => {
    setMessage(null);
    setReauth(false);
    const next = await auth.beginTotpEnrollment();
    setSecret(next.secret);
    setOtpauthUri(next.otpauthUri);
    setQr(next.qrPngDataUrl);
    setCodes(null);
    setOthersSignedOut(false);
  });

  const confirm = useSubmit(async () => {
    try {
      const result = await auth.confirmTotpEnrollment(normalizeTotpCode(code));
      setCodes(result.recoveryCodes);
      setSecret(null);
      setOtpauthUri(null);
      setQr(null);
      setOthersSignedOut(true);
      setMessage(null);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'enrollment_expired') {
        setSecret(null);
        setOtpauthUri(null);
        setQr(null);
        setCodes(null);
        setMessage('Setup timed out. Start again.');
        return;
      }
      if (error instanceof ApiError && error.code === 'invalid_code') {
        setMessage(INVALID_CODE);
        return;
      }
      if (error instanceof ApiError && error.code === 'reauth_required') {
        setReauth(true);
        setMessage('For your security, sign in again to change two-factor settings.');
        return;
      }
      if (error instanceof ApiError && error.code === 'totp_already_enabled') {
        setSecret(null);
        setOtpauthUri(null);
        setQr(null);
        const next = await auth.loadMe();
        setMe(next);
        return;
      }
      setMessage(describeError(error));
    }
  });

  const enrolling = qr !== null && secret !== null;
  const showSetup = codes === null && !enrolling && me !== null && !me.totp.enabled;

  return (
    <Page title="Two-factor settings">
      <View style={styles.column}>
        {staffSetup ? <Notice text={STAFF_SETUP_NOTICE} /> : null}
        {me !== null && me.totp.enabled && codes === null && !enrolling ? (
          <Message>{`Two-factor is on. ${String(me.totp.recoveryCodesRemaining)} recovery codes left.`}</Message>
        ) : null}
        {showSetup ? <Button label="Set up two-factor" onPress={() => { enroll.submit(); }} /> : null}
        {enrolling ? (
          <>
            <Image source={{ uri: qr }} accessibilityLabel="Authentication QR code" style={{ width: 240, height: 240 }} />
            <Text selectable style={styles.code}>{secret}</Text>
            {Platform.OS !== 'web' && otpauthUri?.startsWith('otpauth://') === true ? (
              <Button variant="link" label="Open in authenticator app" onPress={() => { void Linking.openURL(otpauthUri); }} />
            ) : null}
            <Field
              label="Authentication code"
              value={code}
              onChangeText={setCode}
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              keyboardType="number-pad"
            />
            <Button label="Confirm" onPress={() => { confirm.submit(); }} />
          </>
        ) : null}
        {codes !== null ? (
          <>
            {othersSignedOut ? <Message>Other devices were signed out.</Message> : null}
            <Message>Save these somewhere safe. Each works once.</Message>
            {codes.map((item) => <Text key={item} selectable style={styles.code}>{item}</Text>)}
            {staffSetup ? (
              <Button label="Sign in again" onPress={() => { void auth.signOut(); }} />
            ) : (
              <Button
                label="I saved these"
                onPress={() => {
                  setCodes(null);
                  setOthersSignedOut(false);
                  void auth.loadMe().then((next) => { setMe(next); }).catch((error: unknown) => { setMessage(describeError(error)); });
                }}
              />
            )}
          </>
        ) : null}
        {message === null ? null : <Message tone="error">{message}</Message>}
        {reauth ? (
          <Button
            label="Sign in again"
            onPress={() => { void auth.signOut('Sign in again to finish setting up two-factor.'); }}
          />
        ) : null}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  // The screen's own column, as before it moved into the portal frame.
  column: { maxWidth: 480, gap: theme.space[4] },
  // Geist Mono on web; native keeps the platform monospace face it used before.
  code: { ...theme.type.code, fontFamily: theme.type.code.fontFamily ?? 'monospace', color: theme.color.white },
});
