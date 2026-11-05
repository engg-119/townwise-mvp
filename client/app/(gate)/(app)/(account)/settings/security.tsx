import { useCallback, useId, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../../../../src/api/client';
import { normalizeTotpCode, type Me } from '../../../../../src/auth/auth';
import { useAuth } from '../../../../../src/auth/AuthProvider';
import { errorCopy } from '../../../../../src/portal/errors';
import { plural } from '../../../../../src/portal/format';
import { useBreakpoint } from '../../../../../src/portal/hooks';
import { useOptionalPortal } from '../../../../../src/portal/PortalProvider';
import { Page } from '../../../../../src/portal/shell/Page';
import { Actions, Button, LinkButton } from '../../../../../src/portal/ui/Button';
import { ErrorNotice, Notice } from '../../../../../src/portal/ui/feedback';
import { FormField } from '../../../../../src/portal/ui/FormField';
import { Columns, Panel, Stack } from '../../../../../src/portal/ui/layout';
import { Body, Eyebrow, Heading, Small } from '../../../../../src/portal/ui/text';
import { theme } from '../../../../../src/theme';
import { useSubmit } from '../../../../../src/ui';

// P7. Two-step sign-in (spec 16.2, F9), in the SignIn board's pattern: eyebrow, title, lead, then each step in a
// panel. Step 1 adds Townwise to an authenticator app (the otpauth link on this phone, the setup key, or the QR
// from another screen); step 2 confirms a code; then the recovery codes. Staff in staff_setup_required read why
// in the lead, and after the recovery codes sign in again, so the next session passes a code.

const INVALID_CODE = 'That code didn’t work. Codes change every 30 seconds; wait for a new one and try again.';
const REAUTH = 'For your security, sign in again to set up two-step sign-in.';
const STAFF_SETUP_NOTICE = 'Townwise staff accounts need two-step sign-in. Set up your authenticator app, then sign in again with a code.';

/** "ABCD EFGH IJKL …": the setup key in fours, so a line breaks between groups and it is easier to type. */
function groupKey(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

const COPY_FAILED = 'Couldn’t copy. Select the text and copy it.';

/**
 * Copies `text` on web, where the browser offers a clipboard; native shows the text selectable instead. The result
 * is read from a polite live region that is there before the press: “Copied” (unseen, since the button says it),
 * or the line on copying by hand, which also describes the button.
 */
function CopyButton(props: { text: string; label: string }): React.JSX.Element | null {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const noteId = `${useId().replace(/:/g, '')}-copy`;
  const clipboard = Platform.OS === 'web' ? (navigator as { clipboard?: Clipboard }).clipboard : undefined;
  if (clipboard === undefined) return null;
  return (
    <View style={styles.copy}>
      <Button
        variant="outline"
        label={state === 'copied' ? 'Copied' : props.label}
        {...(state === 'failed' ? { describedBy: noteId } : {})}
        onPress={() => {
          clipboard.writeText(props.text).then(() => { setState('copied'); }, () => { setState('failed'); });
        }}
      />
      <View role="status" aria-live="polite">
        {state === 'copied' ? <Text style={styles.unseen}>Copied</Text> : null}
        {state === 'failed' ? <Small nativeID={noteId} style={styles.copyNote}>{COPY_FAILED}</Small> : null}
      </View>
    </View>
  );
}

export default function SecurityScreen(): React.JSX.Element {
  const auth = useAuth();
  const { phone } = useBreakpoint();
  const staffSetup = useOptionalPortal()?.me.access.state === 'staff_setup_required';
  const [me, setMe] = useState<Me | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUri, setOtpauthUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  // A wrong code prints under the code field; everything else under the steps.
  const [codeMessage, setCodeMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const [othersSignedOut, setOthersSignedOut] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    void auth.loadMe().then((next) => {
      if (!cancelled) setMe(next);
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(errorCopy(error));
    });
    return () => { cancelled = true; };
  }, [auth]);

  useFocusEffect(load);

  function clearEnrollment(): void {
    setSecret(null);
    setOtpauthUri(null);
    setQr(null);
  }

  /** The refusals starting and confirming share. */
  async function refuse(error: unknown): Promise<void> {
    if (error instanceof ApiError && error.code === 'reauth_required') {
      setReauth(true);
      setMessage(REAUTH);
      return;
    }
    if (error instanceof ApiError && error.code === 'totp_already_enabled') {
      clearEnrollment();
      try {
        setMe(await auth.loadMe());
      } catch (loadError) {
        setMessage(errorCopy(loadError));
      }
      return;
    }
    setMessage(errorCopy(error));
  }

  const enroll = useSubmit(async () => {
    setMessage(null);
    setCodeMessage(null);
    setReauth(false);
    try {
      const next = await auth.beginTotpEnrollment();
      setSecret(next.secret);
      setOtpauthUri(next.otpauthUri);
      setQr(next.qrPngDataUrl);
      setCodes(null);
      setOthersSignedOut(false);
    } catch (error) {
      await refuse(error);
    }
  });

  const confirm = useSubmit(async () => {
    setCodeMessage(null);
    setMessage(null);
    try {
      const result = await auth.confirmTotpEnrollment(normalizeTotpCode(code));
      setCodes(result.recoveryCodes);
      clearEnrollment();
      setOthersSignedOut(true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'enrollment_expired') {
        clearEnrollment();
        setCodes(null);
        setMessage('Setup timed out. Start again.');
        return;
      }
      if (error instanceof ApiError && error.code === 'invalid_code') {
        setCodeMessage(INVALID_CODE);
        return;
      }
      await refuse(error);
    }
  });

  const enrolling = qr !== null && secret !== null;
  const showSetup = codes === null && !enrolling && me !== null && !me.totp.enabled;

  let steps: React.ReactNode = null;
  if (enrolling) {
    // The otpauth link opens an app on this device, so it shows on native and in a phone's browser; a desktop
    // browser has nothing to open it with.
    const open = otpauthUri?.startsWith('otpauth://') === true && (Platform.OS !== 'web' || phone)
      ? <LinkButton key="open" variant="outline" href={otpauthUri} label="Open in authenticator app" />
      : null;
    const key = (
      <View key="key" style={styles.block}>
        <Text style={styles.label}>Setup key</Text>
        <Text selectable style={styles.key}>{groupKey(secret)}</Text>
        <CopyButton text={secret} label="Copy" />
      </View>
    );
    const scan = <Image key="qr" source={{ uri: qr }} accessibilityLabel="Authentication QR code" style={styles.qr} />;
    steps = (
      <>
        <Panel>
          <View style={styles.head}><Eyebrow>Step 1</Eyebrow><Heading>Add Townwise to your authenticator app</Heading></View>
          <Small>
            {phone
              ? 'Open the link on this phone, or type the setup key into your authenticator app.'
              : 'Scan the QR code with your phone’s authenticator app, or type the setup key into it.'}
          </Small>
          {/* On a phone the page is on the device with the app, so the link comes first; elsewhere the QR does. */}
          {phone ? [open, key, scan] : [scan, key, open]}
        </Panel>
        <Panel>
          <View style={styles.head}><Eyebrow>Step 2</Eyebrow><Heading>Enter the code</Heading></View>
          <Small>Enter the 6-digit code your authenticator app shows for Townwise.</Small>
          <FormField
            label="Code"
            value={code}
            onChangeText={setCode}
            onSubmitEditing={() => { confirm.submit(); }}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            keyboardType="number-pad"
            inputMode="numeric"
            numeric
            messages={codeMessage === null ? [] : [codeMessage]}
            alert
          />
          <Button label="Confirm" block={phone} disabled={confirm.pending} onPress={() => { confirm.submit(); }} />
        </Panel>
      </>
    );
  } else if (codes !== null) {
    steps = (
      <>
        {othersSignedOut ? <Notice text="Other devices were signed out." /> : null}
        <Panel>
          <Heading>Save your recovery codes</Heading>
          <Small>If you lose your phone, sign in with one of these instead of a code. Each works once.</Small>
          <View role="list" aria-label="Recovery codes" style={styles.codes}>
            {codes.map((item) => <Text key={item} role="listitem" selectable style={styles.recovery}>{item}</Text>)}
          </View>
          <CopyButton text={codes.join('\n')} label="Copy all" />
        </Panel>
        <Actions>
          {staffSetup ? (
            <Button label="Sign in again" onPress={() => { void auth.signOut(); }} />
          ) : (
            <Button
              label="I saved these"
              onPress={() => {
                setCodes(null);
                setOthersSignedOut(false);
                void auth.loadMe().then((next) => { setMe(next); }).catch((error: unknown) => { setMessage(errorCopy(error)); });
              }}
            />
          )}
        </Actions>
      </>
    );
  } else if (showSetup) {
    steps = (
      <Panel>
        <Heading>Before you start</Heading>
        <Small>You need an authenticator app on your phone. Setup has two steps: add Townwise to the app, then enter the 6-digit code it shows.</Small>
        <Actions>
          <Button label="Set up two-step sign-in" disabled={enroll.pending} onPress={() => { enroll.submit(); }} />
        </Actions>
      </Panel>
    );
  } else if (me?.totp.enabled === true) {
    steps = <Body>{`Two-step sign-in is on. ${plural(me.totp.recoveryCodesRemaining, 'recovery code', 'recovery codes')} left.`}</Body>;
  }

  return (
    <Page
      gate
      eyebrow={staffSetup ? 'Townwise staff' : 'Settings'}
      title="Two-step sign-in"
      {...(staffSetup ? { lead: STAFF_SETUP_NOTICE } : {})}
    >
      <Columns
        main={(
          <Stack gap={theme.space[5]}>
            {steps}
            {message === null ? null : <ErrorNotice message={message} />}
            {reauth ? (
              <Actions>
                <Button label="Sign in again" onPress={() => { void auth.signOut('Sign in again to finish setting up two-step sign-in.'); }} />
              </Actions>
            ) : null}
          </Stack>
        )}
      />
    </Page>
  );
}

const c = theme.color;
// Geist Mono on web; native keeps the platform monospace face it used before.
const monoFace = theme.type.code.fontFamily ?? 'monospace';

const styles = StyleSheet.create({
  head: { gap: theme.space[2] },
  block: { gap: theme.space[2], alignItems: 'flex-start' },
  label: { ...theme.type.ui, color: c.white },
  key: { ...theme.type.code, fontFamily: monoFace, color: c.white },
  qr: { width: 240, height: 240 },
  copy: { alignItems: 'flex-start' },
  copyNote: { marginTop: theme.space[2] },
  // Read by screen readers, but takes no space and shows nothing.
  unseen: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
  codes: { gap: theme.space[1] },
  recovery: { ...theme.type.monoUi, fontFamily: monoFace, fontVariant: ['tabular-nums'], color: c.white },
});
