import { Link } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { itemHref } from '../../portal/routing';
import { useHover } from '../../portal/ui/hover';
import { theme } from '../../theme';
import type { MessageAttachment } from '../api';
import { chipWords, isFileRef } from '../attachments';
import { AttachmentThumb } from './AttachmentThumb';

// A file the person's message carries (spec P25, D36), as a chip over their bubble: the file's name and its kind, or
// the kind alone under view-as and once the file is gone, and in words whether it is turned off or no longer on Your
// data. Pressing it opens the file's item page on Your data (P27); a file that is gone has no page, so its chip is no
// link, and neither is one whose ref isn't a well-formed file ref, which never becomes a path. On web a picture that is
// on shows a thumbnail above its words (AttachmentThumb.web.tsx), never under view-as.

export function AttachmentChip(props: { attachment: MessageAttachment; locationId: string; viewAs: boolean }): React.JSX.Element {
  const { attachment } = props;
  const hover = useHover();
  const { title, line } = chipWords(attachment);
  const linked = attachment.state !== 'gone' && isFileRef(attachment.ref);
  const thumb = linked && attachment.kind === 'picture' && attachment.state === 'on' && !props.viewAs
    ? <AttachmentThumb locationId={props.locationId} fileRef={attachment.ref} />
    : null;
  const words = (
    <>
      {thumb}
      <Text numberOfLines={1} style={styles.title}>{title}</Text>
      {line === null ? null : <Text style={styles.line}>{line}</Text>}
    </>
  );
  const label = line === null ? title : `${title}, ${line}`;
  if (!linked) {
    return <View role="listitem" accessible accessibilityLabel={label} style={styles.chip}>{words}</View>;
  }
  return (
    <View role="listitem" style={styles.item}>
      <Link href={itemHref(props.locationId, attachment.ref)} asChild>
        {/* A child of Link asChild takes one plain style object (ui/hover.ts). */}
        <Pressable
          role="link"
          accessibilityLabel={`${label}. Open on Your data`}
          onHoverIn={hover.onHoverIn}
          onHoverOut={hover.onHoverOut}
          style={StyleSheet.flatten([styles.chip, hover.hovered ? styles.chipHover : null])}
        >
          {words}
        </Pressable>
      </Link>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  item: { maxWidth: '100%', minWidth: 0 },
  // Rounded like the bubble it sits over (spec 15.6's TownwiseAI exception).
  chip: {
    gap: 2, minHeight: 44, maxWidth: 264, minWidth: 0, justifyContent: 'center', paddingHorizontal: theme.space[3], paddingVertical: theme.space[2],
    borderRadius: 16, borderWidth: theme.stroke.hairline, borderColor: c.border, backgroundColor: c.panel,
  },
  chipHover: { borderColor: c.white },
  title: { ...theme.type.ui, color: c.white },
  line: { ...theme.type.mono, color: c.text2 },
});
