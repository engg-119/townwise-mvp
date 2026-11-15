import { useEffect, useId, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { FeedbackReason } from '../api';
import { copyText } from '../copyText';
import { messageText, type ChatMessage, type TuningChat } from '../useTuningChat';
import { Announce, ChatButton, type ChatButtonHandle } from './controls';
import { described } from './described';
import { Check, CopyIcon, Regenerate, Thumb } from './icons';
import { MessageTime, rowMark, type RowShow } from './MessageTime';

// The actions under a finished reply (owner decision 3, "Message actions"): Copy (web only: native has no clipboard
// module and keeps the text selectable), Regenerate on the newest reply only, and Helpful / Not helpful as a thumb up
// and a thumb down named by those words, ChatGPT's way: once rated only the chosen one shows, pressed, in mint, and
// pressing it again clears the rating. After Not
// helpful, an optional reason from six fixed ones (never free text), or Skip. Every action is aria-disabled while
// the chat can't act and under view-as, where staff see the author's rating in place.

const COPIED_MS = 2000;

const REASONS: readonly { value: FeedbackReason; label: string }[] = [
  { value: 'wrong_figures', label: 'Got my numbers wrong' },
  { value: 'made_up', label: 'Made something up' },
  { value: 'missed_context', label: 'Missed something I told it' },
  { value: 'not_helpful', label: 'Didn’t answer my question' },
  { value: 'too_long', label: 'Too long' },
  { value: 'other', label: 'Something else' },
];

export function ReplyActions(props: {
  message: ChatMessage;
  /** The newest reply of the path shown: the only one that can be regenerated. */
  newest: boolean;
  /** Whether the row always shows (the newest message's) or only on hover and focus (web). */
  show: RowShow;
  chat: TuningChat;
  /** False while a reply streams or a version or conversation loads. */
  canAct: boolean;
  readOnlyId: string | null;
  /** Drawn at the end of the row (the version navigator). */
  children?: React.ReactNode;
}): React.JSX.Element | null {
  const { message, chat } = props;
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [asking, setAsking] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A version switch draws every message anew, so the clipboard can answer after this reply has gone.
  const mounted = useRef(false);
  const notHelpful = useRef<ChatButtonHandle>(null);
  const questionId = `${useId().replace(/:/g, '')}-question`;
  const off = !props.canAct || props.readOnlyId !== null;
  const rating = message.feedback?.rating ?? null;
  const source = messageText(message);
  const canCopy = Platform.OS === 'web' && source.trim() !== '';
  const canRegenerate = props.newest && message.parentId !== null;
  const canRate = message.nodeId !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    };
  }, []);

  if (!canCopy && !canRegenerate && !canRate && (props.children === undefined || props.children === null)) return null;

  function onCopy(): void {
    void copyText(source).then((copied) => {
      if (!mounted.current) return;
      setCopy(copied ? 'copied' : 'failed');
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { setCopy('idle'); }, COPIED_MS);
    });
  }

  function onRate(choice: 'up' | 'down'): void {
    if (rating === choice) {
      chat.rate(message.key, null);
      setAsking(false);
      return;
    }
    chat.rate(message.key, choice);
    setAsking(choice === 'down');
  }

  /** The reason group closes once a reason is chosen or skipped; focus goes back to the rating it follows. */
  function onReason(reason: FeedbackReason | null): void {
    if (reason !== null) chat.rate(message.key, 'down', reason);
    if (Platform.OS === 'web') notHelpful.current?.focus();
    setAsking(false);
  }

  const copyLabel = copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Couldn’t copy' : 'Copy';
  const describedBy = described(props.readOnlyId);
  return (
    <View style={styles.actions}>
      <View style={styles.icons} {...rowMark(props.show)}>
        {canCopy ? (
          <ChatButton
            variant="arrow"
            label={copyLabel}
            icon={(color) => (copy === 'copied' ? <Check color={color} /> : <CopyIcon color={color} />)}
            disabled={off}
            {...describedBy}
            onPress={onCopy}
          />
        ) : null}
        {canRegenerate ? (
          // A regenerate is a turn, so it waits for next month's budget too.
          <ChatButton
            variant="arrow"
            label="Regenerate"
            icon={(color) => <Regenerate color={color} />}
            disabled={off || chat.state.budget?.exhausted === true}
            {...describedBy}
            onPress={() => { chat.regenerate(message.key); }}
          />
        ) : null}
        {canRate && rating !== 'down' ? (
          <ChatButton
            key="up"
            variant="arrow"
            label="Helpful"
            icon={(color) => <Thumb color={color} />}
            pressed={rating === 'up'}
            disabled={off}
            {...describedBy}
            onPress={() => { onRate('up'); }}
          />
        ) : null}
        {canRate && rating !== 'up' ? (
          <ChatButton
            key="down"
            focusRef={notHelpful}
            variant="arrow"
            label="Not helpful"
            icon={(color) => <Thumb down color={color} />}
            pressed={rating === 'down'}
            disabled={off}
            {...describedBy}
            onPress={() => { onRate('down'); }}
          />
        ) : null}
        <MessageTime at={message.at} />
        {props.children}
      </View>
      {asking && rating === 'down' ? (
        // Named by the question it shows, so it is read once on entering the group.
        <View role="group" aria-labelledby={questionId} style={styles.reasons}>
          <Text nativeID={questionId} style={styles.question}>What went wrong? Optional.</Text>
          <View style={styles.row}>
            {REASONS.map((reason) => (
              <ChatButton key={reason.value} variant="outline" label={reason.label} disabled={off} {...describedBy} onPress={() => { onReason(reason.value); }} />
            ))}
            <ChatButton variant="link" label="Skip" disabled={off} {...describedBy} onPress={() => { onReason(null); }} />
          </View>
        </View>
      ) : null}
      {message.ratingError === null ? null : <Text role="alert" style={styles.error}>{message.ratingError}</Text>}
      {canCopy ? <Announce text={copy === 'copied' ? 'Copied the reply.' : ''} /> : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  actions: { gap: theme.space[2] },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4], rowGap: theme.space[2] },
  // A compact row (spec P25): the 44px boxes side by side, so their 18px icons sit 26px apart.
  icons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: theme.space[2] },
  reasons: { gap: theme.space[2] },
  question: { ...theme.type.small, color: c.text2 },
  error: { ...theme.type.small, color: c.white },
});
