import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';
import { Markdown } from '../markdown/Markdown';
import { basedOnLine, type ToolContext } from '../tools';
import type { TreeNode } from '../tree';
import { stepsOf, type ChatMessage, type TuningChat } from '../useTuningChat';
import { VisualView } from '../visuals/Visual';
import { focusLost, Hidden } from './controls';
import { described } from './described';
import { ItemProposalCard } from './ItemProposalCard';
import { OrderProposalCard } from './OrderProposalCard';
import { ProposalCard } from './ProposalCard';
import { messageMark, type RowShow } from './MessageTime';
import { ReplyActions } from './ReplyActions';
import { Sources } from './ToolGroup';
import { useVersionNav, VersionNav } from './VersionNav';
import { isProcessPart, wholeSeconds, Worked, Working } from './Worked';

// One of TownwiseAI's replies (owner decisions 3 to 5): no label box, only a hidden "TownwiseAI said", then its parts
// in the order they streamed: Markdown text (with a static caret at its end while text is what streams), visuals
// Townwise drew, and proposal cards (a note's, or one to keep text on Your data, D28). Its thinking summary and tool calls are the timeline at its top: "Working for
// {n}s" with the timeline under it while it streams (the counter alone before anything arrives), then a collapsed "Worked
// for {n}s" that opens to the same timeline (Worked.tsx). Finished, it has its actions, its version navigator when it has siblings, the Based on line
// built from its tool calls (never written by the model), the pages it cites from the web, and why it ended early, if it did. One that failed or was
// stopped keeps its note and Try again.

export function ReplyView(props: {
  message: ChatMessage;
  ctx: ToolContext;
  tree: readonly TreeNode[];
  /** The newest reply of the path shown (Regenerate). */
  newest: boolean;
  /** Whether its row of actions always shows (the last message of the thread) or only on hover and focus. */
  actions: RowShow;
  chat: TuningChat;
  locationId: string;
  readOnlyId: string | null;
  /** False while a reply streams or a version or conversation loads: actions, versions and Try again are off. */
  canAct: boolean;
  onRetry: (key: string) => void;
  /**
   * Says `words` ("Showing version 2 of 3." after a version switch) through the page's one polite live region, which
   * must outlive the messages (a switch draws every message anew), and on iOS with announceForAccessibility, as the
   * page says its own sentences. Each call is news, even when the words repeat the last ones.
   */
  onAnnounce: (words: string) => void;
}): React.JSX.Element {
  const { message, chat } = props;
  const live = message.state === 'streaming';
  const ended = message.state === 'failed' || message.state === 'stopped';
  const complete = message.state === 'complete';
  const nav = useVersionNav(chat, message, props.tree, props.onAnnounce);
  // A streaming reply always has its start (the reducer stamps it); this keeps the timeline up if one ever lacks it.
  const [mounted] = useState(() => Date.now());
  const process = message.parts.filter(isProcessPart);
  const endedFor = message.startedAt !== null && message.endedAt !== null ? wholeSeconds(message.startedAt, message.endedAt) : null;
  // The caret ends the text while text is what streams; once a step or visual follows, the counter says it is working.
  const last = message.parts.at(-1);
  const caretOn = live && last?.type === 'text' ? last.key : null;

  // A regenerated reply: once it is saved as the newest version, focus goes to its navigator (the Regenerate
  // button that was pressed went with the earlier reply), unless the person has put focus somewhere since, such as
  // the composer to type the next question.
  const regenerated = useRef(false);
  const regenerating = live && chat.state.turn?.kind === 'regenerate';
  const navCount = nav.versions?.count ?? 0;
  const { focusRef } = nav;
  useEffect(() => {
    if (regenerating) regenerated.current = true;
  }, [regenerating]);
  useEffect(() => {
    if (!regenerated.current || !complete || navCount < 2) return;
    regenerated.current = false;
    if (Platform.OS === 'web' && focusLost()) focusRef.current?.focus(-1);
  }, [complete, navCount, focusRef]);

  const versions = nav.versions === null ? null : (
    <VersionNav
      index={nav.versions.index}
      count={nav.versions.count}
      disabled={!props.canAct}
      onStep={nav.onStep}
      focusRef={nav.focusRef}
    />
  );

  return (
    <View style={styles.reply} {...messageMark()}>
      <Hidden>TownwiseAI said</Hidden>
      {live ? <Working startedAt={message.startedAt ?? mounted} parts={process} ctx={props.ctx} /> : null}
      {!live ? <Worked seconds={endedFor} parts={process} ctx={props.ctx} /> : null}
      {message.parts.map((part) => {
        if (part.type === 'text') return <Markdown key={part.key} source={part.text} caret={part.key === caretOn} />;
        if (part.type === 'thinking' || part.type === 'tools') return null;
        if (part.type === 'visual') return <VisualView key={part.key} visual={part.visual} />;
        if (part.type === 'item') {
          return <ItemProposalCard key={part.key} card={part.card} locationId={props.locationId} actions={chat} readOnlyId={props.readOnlyId} />;
        }
        if (part.type === 'order') {
          return <OrderProposalCard key={part.key} card={part.card} locationId={props.locationId} readOnlyId={props.readOnlyId} />;
        }
        return <ProposalCard key={part.key} card={part.card} locationId={props.locationId} actions={chat} readOnlyId={props.readOnlyId} />;
      })}
      {complete && message.parts.length > 0 ? (
        <>
          <ReplyActions message={message} newest={props.newest} show={props.actions} chat={chat} canAct={props.canAct} readOnlyId={props.readOnlyId}>
            {versions}
          </ReplyActions>
          <Text style={styles.basedOn}>{basedOnLine(stepsOf(message), props.ctx)}</Text>
          {message.sources === undefined || message.sources.length === 0 ? null : (
            // The pages its text cites from the web: Anthropic requires them shown with the reply, not behind a disclosure.
            <View>
              <Text style={styles.basedOn}>Sources</Text>
              <Sources sources={message.sources} />
            </View>
          )}
        </>
      ) : versions}
      {message.note === null ? null : <Text style={styles.note}>{message.note}</Text>}
      {ended ? (
        <Button
          variant="outline"
          label="Try again"
          disabled={!props.canAct || props.readOnlyId !== null || chat.state.budget?.exhausted === true}
          {...described(props.readOnlyId)}
          onPress={() => { props.onRetry(message.key); }}
        />
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  reply: { gap: theme.space[3], minWidth: 0 },
  basedOn: { ...theme.type.small, color: c.text2 },
  note: { ...theme.type.small, color: c.text3 },
});
