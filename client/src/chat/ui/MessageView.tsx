import { StyleSheet, Text, View } from 'react-native';

import { useBreakpoint } from '../../portal/hooks';
import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';
import { basedOnLine, type ToolContext } from '../tools';
import { stepsOf, type ChatMessage } from '../useTuningChat';
import { described } from './described';
import { ProposalCard, type ProposalActions } from './ProposalCard';
import { ToolGroup } from './ToolGroup';
import { VisualView } from '../visuals/Visual';

// One message of the log (spec P25): the person's in a square panel (right-aligned at 80% from tablet up), and
// TownwiseAI's as its parts in the order they streamed: text, tool calls, more text, visuals, proposal cards. Under a
// finished reply, the Based on line, built from its tool calls and never written by the model; under a reply that
// ended early, why; under one that failed or was stopped, Try again.

/** Paragraph breaks render as gaps. */
function Paragraphs(props: { text: string }): React.JSX.Element {
  const paragraphs = props.text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <View style={styles.paragraphs}>
      {paragraphs.map((paragraph, index) => <Text key={index} selectable style={styles.text}>{paragraph}</Text>)}
    </View>
  );
}

export function MessageView(props: {
  message: ChatMessage;
  ctx: ToolContext;
  locationId: string;
  actions: ProposalActions;
  readOnlyId: string | null;
  /** Try again is offered (not while another reply streams). */
  canRetry: boolean;
  onRetry: (replyKey: string) => void;
}): React.JSX.Element {
  const { message } = props;
  const { phone } = useBreakpoint();
  if (message.role === 'user') {
    return (
      <View style={[styles.user, phone ? null : styles.userWide]}>
        <Text style={styles.label}>You</Text>
        {message.parts.map((part) => (part.type === 'text' ? <Paragraphs key={part.key} text={part.text} /> : null))}
      </View>
    );
  }
  const live = message.state === 'streaming';
  const ended = message.state === 'failed' || message.state === 'stopped';
  return (
    <View style={styles.reply}>
      <Text style={styles.label}>TownwiseAI</Text>
      {message.parts.map((part) => {
        if (part.type === 'text') return <Paragraphs key={part.key} text={part.text} />;
        if (part.type === 'tools') return <ToolGroup key={part.key} steps={part.steps} live={live} ctx={props.ctx} />;
        if (part.type === 'visual') return <VisualView key={part.key} visual={part.visual} />;
        return <ProposalCard key={part.key} card={part.card} locationId={props.locationId} actions={props.actions} readOnlyId={props.readOnlyId} />;
      })}
      {message.state === 'complete' && message.parts.length > 0 ? (
        <Text style={styles.basedOn}>{basedOnLine(stepsOf(message), props.ctx)}</Text>
      ) : null}
      {message.note === null ? null : <Text style={styles.note}>{message.note}</Text>}
      {ended ? (
        <Button
          variant="outline"
          label="Try again"
          disabled={!props.canRetry || props.readOnlyId !== null}
          {...described(props.readOnlyId)}
          onPress={() => { props.onRetry(message.key); }}
        />
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  label: { ...theme.type.label, color: c.text3 },
  paragraphs: { gap: theme.space[3] },
  text: { ...theme.type.sub, color: c.white },
  // Square corners everywhere in the app (spec 15.6).
  user: {
    gap: theme.space[2], padding: theme.space[3], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  userWide: { alignSelf: 'flex-end', maxWidth: '80%' },
  reply: { gap: theme.space[3] },
  basedOn: { ...theme.type.small, color: c.text2 },
  note: { ...theme.type.small, color: c.text3 },
});
