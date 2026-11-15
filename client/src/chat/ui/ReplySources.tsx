import { useId } from 'react';
import { Link } from 'expo-router';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { shownHost, type SourceLink } from '../tools';

// The pages a reply cites from its web searches (spec D37, P25), under its Based on line: a list labelled “Sources”,
// one link per page, named by its host without `www.`. On web each opens in a new tab, as the reply's own links do
// (Markdown.tsx); on native the system browser opens it. Only https links reach here (src/chat/api.ts), and there are
// links only, never an image, so the CSP is unchanged.

function SourceItem(props: { source: SourceLink }): React.JSX.Element {
  const { url } = props.source;
  const host = shownHost(props.source.host);
  if (Platform.OS === 'web') {
    return <Link href={url} target="_blank" rel="noopener noreferrer" style={styles.link}>{host}</Link>;
  }
  return (
    <Pressable role="link" onPress={() => { void Linking.openURL(url); }} style={styles.press}>
      <Text style={styles.linkText}>{host}</Text>
    </Pressable>
  );
}

export function ReplySources(props: { sources: readonly SourceLink[] }): React.JSX.Element | null {
  const id = `sources-${useId().replace(/:/g, '')}`;
  if (props.sources.length === 0) return null;
  return (
    <View style={styles.block}>
      <Text id={id} nativeID={id} style={styles.label}>Sources</Text>
      <View role="list" aria-labelledby={id} style={styles.list}>
        {props.sources.map((source) => <View key={source.url} role="listitem"><SourceItem source={source} /></View>)}
      </View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  block: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4], minWidth: 0 },
  label: { ...theme.type.small, color: c.text2 },
  list: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[4], minWidth: 0 },
  link: { ...theme.type.small, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line, paddingVertical: 12 },
  press: { minHeight: 44, justifyContent: 'center' },
  linkText: { ...theme.type.small, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
});
