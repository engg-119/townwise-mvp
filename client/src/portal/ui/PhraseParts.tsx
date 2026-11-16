import { StyleSheet, Text } from 'react-native';

import type { Phrase } from '../analytics/phrase';

/**
 * A phrase's parts inside a text (Small, Mono): its strong parts bold, in the text's own font and color, the rest as
 * the words around them. Nested texts read as one sentence on web and native.
 */
export function PhraseParts(props: { phrase: Phrase }): React.JSX.Element {
  return (
    <>
      {props.phrase.map((part, index) => (typeof part === 'string'
        ? part
        // Keyed by place: a phrase is built in one order and never reordered.
        : <Text key={index} style={styles.strong}>{part.strong}</Text>))}
    </>
  );
}

const styles = StyleSheet.create({
  strong: { fontWeight: '700' },
});
