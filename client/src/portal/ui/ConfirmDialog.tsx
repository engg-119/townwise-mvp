import { useId, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Actions, Button } from './Button';
import { ErrorNotice } from './feedback';
import { FormField } from './FormField';
import { Heading } from './text';

// The confirm dialog (spec 15.7, shell.md 7.9): a `panel`, square, at most 560px wide, over a `ground` backdrop
// at 80%. The title is `tw-h3`, the body `small` `text2`, and the actions sit flush left: the dialog's one primary,
// then Cancel as a text link. Destructive actions have no red. Deleting data adds the typed-name field, and the
// action stays disabled until it matches. Focus is trapped while open and returns to the opener on close, and
// Escape closes it (react-native-web's Modal; Android's back button on native). While the action runs, Cancel is
// disabled and Escape and back do nothing, so its answer always lands in the open dialog. Nothing animates.

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  /** The label while the action runs ("Deleting…"). */
  pendingLabel?: string;
  pending?: boolean;
  /** What the action threw, shown in the dialog with the shared copy. */
  error?: unknown;
  /** The name to type: the field reads “Type {name} to confirm.” */
  typedName?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Once the dialog has gone, after it returned focus to its opener (web: react-native-web's focus trap is gone, so
   * focus can move elsewhere). For an action that took the opener away.
   */
  onDismiss?: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="none"
      onRequestClose={() => { if (props.pending !== true) props.onCancel(); }}
      {...(props.onDismiss === undefined ? {} : { onDismiss: props.onDismiss })}
    >
      {props.visible ? <DialogBody {...props} /> : null}
    </Modal>
  );
}

function DialogBody(props: ConfirmDialogProps): React.JSX.Element {
  const { phone } = useBreakpoint();
  const titleId = `${useId().replace(/:/g, '')}-title`;
  const [typed, setTyped] = useState('');
  const { typedName } = props;
  const matches = typedName === undefined || typed.trim() === typedName;
  const pending = props.pending === true;
  const hasError = props.error !== undefined && props.error !== null;
  return (
    <View style={styles.backdrop}>
      <View role="dialog" aria-modal aria-labelledby={titleId} style={[styles.dialog, { padding: phone ? theme.space[4] : theme.space[6] }]}>
        <Heading nativeID={titleId}>{props.title}</Heading>
        <Text style={styles.body}>{props.body}</Text>
        {typedName === undefined ? null : (
          <FormField label={`Type ${typedName} to confirm.`} value={typed} onChangeText={setTyped} autoComplete="off" autoCorrect={false} />
        )}
        {hasError ? <ErrorNotice error={props.error} /> : null}
        <Actions>
          <Button
            label={pending ? (props.pendingLabel ?? props.confirmLabel) : props.confirmLabel}
            disabled={!matches || pending}
            onPress={props.onConfirm}
          />
          <Button variant="link" label="Cancel" disabled={pending} onPress={props.onCancel} />
        </Actions>
      </View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: c.scrim, alignItems: 'center', justifyContent: 'center', padding: theme.space[4] },
  dialog: { width: '100%', maxWidth: 560, backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, gap: theme.space[4] },
  body: { ...theme.type.small, color: c.text2 },
});
