import { Modal, ScrollView, StyleSheet, View } from 'react-native';

import { MODEL_CARD_TITLE, ModelCard } from '../../portal/estimates/ModelCard';
import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';

// F10: the model card ("How Townwise estimates", src/portal/estimates/ModelCard.tsx) in a sheet over the Agent page,
// opened from How TownwiseAI works, so the page and TownwiseAI point at the same facts without a new route. It is the
// confirm dialog's frame (src/portal/ui/ConfirmDialog.tsx): focus is trapped while open and goes back to the opener,
// and Escape (Android's back button on native) or Close shuts it. The card scrolls inside it. Nothing animates.

export function ModelCardSheet(props: { visible: boolean; locationId: string; onClose: () => void }): React.JSX.Element {
  return (
    <Modal visible={props.visible} transparent animationType="none" onRequestClose={props.onClose}>
      {props.visible ? (
        <View style={styles.backdrop}>
          <View role="dialog" aria-modal aria-label={MODEL_CARD_TITLE} style={styles.sheet}>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
              <ModelCard locationId={props.locationId} />
            </ScrollView>
            <View style={styles.actions}>
              <Button variant="outline" label="Close" onPress={props.onClose} />
            </View>
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8, 10, 13, 0.8)', alignItems: 'center', justifyContent: 'center', padding: theme.space[4] },
  sheet: { width: '100%', maxWidth: 720, maxHeight: '100%', backgroundColor: c.ground, borderWidth: 1, borderColor: c.border },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { padding: theme.space[2] },
  actions: { flexDirection: 'row', padding: theme.space[4], borderTopWidth: theme.stroke.hairline, borderTopColor: c.line },
});
