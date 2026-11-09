import { useEffect, useRef } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { webAria } from '../../portal/ui/aria';
import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';

// The "Questions and activity" panel below 1024px (spec P25, chat redesign): a full-screen `ground` layer with the
// heading, which takes focus on open, and Close. Focus stays inside (the Modal traps it); Escape, Android's back
// button and Close shut it and focus goes back to the button that opened it. From 1024px the panel is a column
// beside the chat, so this renders nothing there. Nothing animates.

export const PANEL_TITLE = 'Questions and activity';

type Host = React.ComponentRef<typeof View>;
type TextHost = React.ComponentRef<typeof Text>;
interface Focusable { focus: () => void }

export function PanelSheet(props: {
  open: boolean;
  onClose: () => void;
  /** The header button that opened the sheet; focus returns to it on close (web). */
  openerRef?: React.RefObject<Host | null>;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const { desktop } = useBreakpoint();
  const shown = props.open && !desktop;
  const heading = useRef<TextHost>(null);
  const wasShown = useRef(false);
  const { onClose, openerRef } = props;

  function close(): void {
    onClose();
  }

  useEffect(() => {
    if (shown) {
      wasShown.current = true;
      // Focus moves after the Modal has mounted its content.
      const timer = setTimeout(() => { (heading.current as unknown as Focusable | null)?.focus(); }, 0);
      return () => { clearTimeout(timer); };
    }
    if (wasShown.current) {
      wasShown.current = false;
      if (Platform.OS === 'web') (openerRef?.current as unknown as Focusable | null | undefined)?.focus();
    }
    return undefined;
  }, [shown, openerRef]);

  useEffect(() => {
    if (!shown || Platform.OS !== 'web') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [shown, onClose]);

  if (!shown) return null;
  return (
    <Modal visible transparent={false} animationType="none" onRequestClose={close}>
      <View role="dialog" aria-modal aria-label={PANEL_TITLE} style={styles.sheet}>
        <View style={styles.bar}>
          <Text
            ref={heading}
            role="heading"
            {...webAria({ 'aria-level': 2 })}
            {...(Platform.OS === 'web' ? { tabIndex: -1 } : { accessible: true })}
            style={styles.heading}
          >
            {PANEL_TITLE}
          </Text>
          <Button variant="outline" label="Close" onPress={close} />
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>{props.children}</ScrollView>
      </View>
    </Modal>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: c.ground },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', columnGap: theme.space[4], padding: theme.space[4],
    borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border,
  },
  heading: { ...theme.type.h3Phone, color: c.white, flex: 1, minWidth: 0 },
  scroll: { flex: 1 },
  content: { padding: theme.space[4], gap: theme.space[6] },
});
