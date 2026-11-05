import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { theme } from '../theme';
import { Screen } from '../ui';

export interface SignInFrameProps {
  title: string;
  lead: string;
  // The line under the card.
  note: string;
  // The card's contents.
  children: React.ReactNode;
}

// Native sign-in: one column. Native has no marketing page (/ goes back into the app), so the wordmark
// is not a link. The web frame (SignInFrame.web.tsx) puts the same parts inside the site's header and footer.
export function SignInFrame(props: SignInFrameProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  return (
    <Screen scroll>
      <Text style={styles.wordmark}>Townwise</Text>
      <Text role="heading" style={[width <= 640 ? theme.type.h1Phone : theme.type.h1Tablet, styles.title]}>{props.title}</Text>
      <Text style={styles.sub}>{props.lead}</Text>
      <View style={styles.card}>{props.children}</View>
      <View style={styles.access}>
        <Text style={[width <= 640 ? theme.type.bodyPhone : theme.type.small, styles.fine]}>{props.note}</Text>
      </View>
    </Screen>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  wordmark: { ...theme.type.wordmark, alignSelf: 'flex-start', paddingVertical: 10, color: c.white, textDecorationLine: 'none' },
  title: { color: c.white },
  sub: { ...theme.type.sub, color: c.text2 },
  card: {
    marginTop: theme.space[4], padding: theme.space[6], gap: theme.space[4],
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, borderRadius: theme.radius.frame,
  },
  // The note is reading text: 16/24 on phones, as the web frame sets it, and 14/20 wider.
  fine: { color: c.text2 },
  access: { marginTop: theme.space[4], paddingTop: theme.space[4], borderTopWidth: 1, borderTopColor: c.border },
});
