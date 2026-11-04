import { Platform, Pressable, Text } from 'react-native';
import { GoogleSignin, isSuccessResponse, statusCodes } from '@react-native-google-signin/google-signin';

import type { Config } from '../config';

export interface GoogleButtonProps {
  google: Config['google'];
  onIdToken: (idToken: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

let configured = false;

export function resetGoogleButtonState(): void {
  configured = false;
}

export function GoogleButton(props: GoogleButtonProps): React.JSX.Element | null {
  const google = props.google;
  if (google === null) return null;
  if (Platform.OS === 'ios' && google.iosClientId === null) return null;
  const client = google;

  async function press(): Promise<void> {
    try {
      if (!configured) {
        GoogleSignin.configure({
          webClientId: client.webClientId,
          ...(client.iosClientId === null ? {} : { iosClientId: client.iosClientId }),
        });
        configured = true;
      }
      const result = await GoogleSignin.signIn();
      if (isSuccessResponse(result)) {
        const idToken = result.data.idToken;
        if (typeof idToken !== 'string' || idToken === '') return;
        try {
          await GoogleSignin.signOut();
        } catch {
          // The app does not keep a Google session. A sign-out failure still leaves the ID token usable once.
        }
        props.onIdToken(idToken);
        return;
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === statusCodes.SIGN_IN_CANCELLED) return;
      if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
        props.onError('Google Play services are not available on this device.');
        return;
      }
      if (code === statusCodes.IN_PROGRESS) {
        props.onError('Google sign-in is already in progress.');
        return;
      }
      props.onError('Google sign-in failed.');
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => { void press(); }}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
    >
      <Text>Sign in with Google</Text>
    </Pressable>
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
