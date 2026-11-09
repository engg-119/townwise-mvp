import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../portal/ui/Button';
import { theme } from '../../theme';
import { liveLine } from '../liveLine';
import { Markdown } from '../markdown/Markdown';
import { basedOnLine, type ToolContext } from '../tools';
import type { TreeNode } from '../tree';
import { stepsOf, type ChatMessage, type TuningChat } from '../useTuningChat';
import { VisualView } from '../visuals/Visual';
import { Hidden } from './controls';
import { described } from './described';
import { ProposalCard } from './ProposalCard';
import { ReplyActions } from './ReplyActions';
import { ToolGroup } from './ToolGroup';
import { useVersionNav, VersionNav } from './VersionNav';

// One of TownwiseAI's replies (owner decisions 3 to 5): no label box, only a hidden "TownwiseAI said", then its parts
// in the order they streamed: Markdown text (with a static caret after the last text part while it streams), tool
// calls, visuals Townwise drew, and proposal cards. While it streams, the live line under it names the running step
// or says it is thinking. Finished, it has its actions, its version navigator when it has siblings, the Based on line
// built from its tool calls (never written by the model) and why it ended early, if it did. One that failed or was
// stopped keeps its note and Try again.

export function ReplyView(props: {
  message: ChatMessage;
  ctx: ToolContext;
  tree: readonly TreeNode[];
  /** The newest reply of the path shown (Regenerate). */
  newest: boolean;
  chat: TuningChat;
  locationId: string;
  readOnlyId: string | null;
  /** False while a reply streams or a version or conversation loads: actions, versions and Try again are off. */
  canAct: boolean;
  onRetry: (key: string) => void;
}): React.JSX.Element {
  const { message, chat } = props;
  const live = message.state === 'streaming';
  const ended = message.state === 'failed' || message.state === 'stopped';
  const complete = message.state === 'complete';
  const nav = useVersionNav(chat, message, props.tree);
  const line = liveLine(message, props.ctx);
  const lastText = message.parts.findLast((part) => part.type === 'text')?.key ?? null;

  // A regenerated reply: once it is saved as the newest version, focus goes to its navigator (the Regenerate
  // button that was pressed went with the earlier reply).
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
    if (Platform.OS === 'web') focusRef.current?.focus(-1);
  }, [complete, navCount, focusRef]);

  const versions = nav.versions === null ? null : (
    <VersionNav
      index={nav.versions.index}
      count={nav.versions.count}
      disabled={!props.canAct}
      onStep={nav.onStep}
      focusRef={nav.focusRef}
      announcement={nav.announcement}
    />
  );

  return (
    <View style={styles.reply}>
      <Hidden>TownwiseAI said</Hidden>
      {message.parts.map((part) => {
        if (part.type === 'text') return <Markdown key={part.key} source={part.text} caret={live && part.key === lastText} />;
        if (part.type === 'tools') return <ToolGroup key={part.key} steps={part.steps} live={live} ctx={props.ctx} />;
        if (part.type === 'visual') return <VisualView key={part.key} visual={part.visual} />;
        return <ProposalCard key={part.key} card={part.card} locationId={props.locationId} actions={chat} readOnlyId={props.readOnlyId} />;
      })}
      {line === null ? null : <Text style={styles.live}>{line}</Text>}
      {complete && message.parts.length > 0 ? (
        <>
          <ReplyActions message={message} newest={props.newest} chat={chat} canAct={props.canAct} readOnlyId={props.readOnlyId}>
            {versions}
          </ReplyActions>
          <Text style={styles.basedOn}>{basedOnLine(stepsOf(message), props.ctx)}</Text>
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
  live: { ...theme.type.small, color: c.text2 },
  basedOn: { ...theme.type.small, color: c.text2 },
  note: { ...theme.type.small, color: c.text3 },
});
