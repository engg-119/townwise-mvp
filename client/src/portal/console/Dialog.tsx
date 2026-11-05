import { useId, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { useBreakpoint } from '../hooks';
import { Actions, Button } from '../ui/Button';
import { Messages, type MessageLink } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Heading } from '../ui/text';

// The console's dialogs (C1, C3, C4, C5, C7 and the rename, suspend, remove and sign-out confirms), with the
// anatomy of ui/ConfirmDialog (spec 15.7): a `panel`, square, at most 560px wide, over a `ground` backdrop at 80%;
// the title `tw-h3`, the body `small` `text2`; flush-left actions, the one primary then Cancel as a text link.
// It adds what the console needs and ConfirmDialog doesn't have: form fields as children, and a refusal in the
// page's own words (409 last_admin, person_has_seat, org_not_suspended), with an optional link. A typed-name
// confirm keeps its action disabled until the name matches. Focus is trapped while open and Escape closes it
// (react-native-web's Modal). While the action runs, Cancel is disabled and Escape does nothing, so its answer
// always lands in the open dialog, and a reopened form can't send the same decision twice. Nothing animates.

export interface Problem {
  text: string;
  link?: MessageLink;
}

export interface DialogProps {
  title: string;
  /**
   * An email that ends the title (“View Townwise as {email}”), set in mono 14/20 so up to 30 characters fit a line
   * of a 320px screen's dialog: it moves to its own line whole instead of breaking mid-word.
   */
  titleEmail?: string;
  body?: string;
  children?: React.ReactNode;
  confirmLabel: string;
  /** The label while the action runs ("Deleting…"). */
  pendingLabel?: string;
  pending: boolean;
  problem: Problem | null;
  /** The name or email to type: the field reads “Type {name} to confirm.” */
  typedName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Open while it is rendered; the page renders it only when its dialog is open. */
export function Dialog(props: DialogProps): React.JSX.Element {
  return (
    <Modal visible transparent animationType="none" onRequestClose={() => { if (!props.pending) props.onCancel(); }}>
      <DialogBody {...props} />
    </Modal>
  );
}

function DialogBody(props: DialogProps): React.JSX.Element {
  const { phone } = useBreakpoint();
  const titleId = `${useId().replace(/:/g, '')}-title`;
  const [typed, setTyped] = useState('');
  const { typedName, problem } = props;
  const matches = typedName === undefined || typed.trim() === typedName;
  return (
    <View style={styles.backdrop}>
      <View role="dialog" aria-modal aria-labelledby={titleId} style={[styles.dialog, { padding: phone ? theme.space[4] : theme.space[6] }]}>
        <Heading nativeID={titleId}>
          {props.title}
          {props.titleEmail === undefined ? null : <>{' '}<Text style={styles.titleEmail}>{props.titleEmail}</Text></>}
        </Heading>
        {props.body === undefined ? null : <Text style={styles.body}>{props.body}</Text>}
        {props.children}
        {typedName === undefined ? null : (
          <FormField label={`Type ${typedName} to confirm.`} value={typed} onChangeText={setTyped} autoComplete="off" autoCorrect={false} />
        )}
        {problem === null ? null : <Messages live="alert" items={[problem.text]} {...(problem.link === undefined ? {} : { link: problem.link })} />}
        <Actions>
          <Button
            label={props.pending ? (props.pendingLabel ?? props.confirmLabel) : props.confirmLabel}
            disabled={!matches || props.pending}
            onPress={props.onConfirm}
          />
          <Button variant="link" label="Cancel" disabled={props.pending} onPress={props.onCancel} />
        </Actions>
      </View>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8, 10, 13, 0.8)', alignItems: 'center', justifyContent: 'center', padding: theme.space[4] },
  dialog: { width: '100%', maxWidth: 560, backgroundColor: c.panel, borderWidth: 1, borderColor: c.border, gap: theme.space[4] },
  body: { ...theme.type.small, color: c.text2 },
  titleEmail: { ...theme.type.monoUi },
});
