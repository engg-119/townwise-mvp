import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';

import type { MeResponse } from '../../portal/schemas';
import { Button } from '../../portal/ui/Button';
import { inlineTarget } from '../../portal/ui/text';
import { theme } from '../../theme';
import { targetHref } from '../dataLinks';
import { Markdown } from '../markdown/Markdown';
import { basedOnParts, type DataTarget, type ToolContext } from '../tools';
import type { TreeNode } from '../tree';
import { stepsOf, type ChatMessage, type MessagePart, type TuningChat } from '../useTuningChat';
import { VisualView } from '../visuals/Visual';
import { focusLost, Hidden } from './controls';
import { described } from './described';
import { ItemProposalCard } from './ItemProposalCard';
import { OrderProposalCard } from './OrderProposalCard';
import { ProposalCard } from './ProposalCard';
import { messageMark, type RowShow } from './MessageTime';
import { ReplyActions } from './ReplyActions';
import { ReplySources } from './ReplySources';
import { FadeIn, type HrefOf } from './ToolGroup';
import { useVersionNav, VersionNav } from './VersionNav';
import { isProcessPart, wholeSeconds, Worked, type ProcessPart } from './Worked';
import { useWorkedOpen, type WorkedOpen } from './workedOpen';

// One of TownwiseAI's replies (owner decisions 3 to 5): no label box, only a hidden "TownwiseAI said", then its parts
// in the order they streamed: Markdown text (with a static caret at its end while text is what streams), visuals
// Townwise drew, and proposal cards (a note's, or one to keep text on Your data, D28). Its thinking summary and tool calls are the timeline at its top
// (Worked.tsx): one component for the whole turn, "Working for {n}s" while it streams and "Worked for {n}s" once it
// ended, closed for every new prompt and opened by the person (owner request, 2026-11-17), their choice kept in the
// page's `workedOpen` by the reply's key and node ids, so it holds as the reply ends and is read again. Finished, it has its actions, its version navigator when it has siblings, the Based on line
// built from its tool calls (never written by the model), the web pages it cites (D37, ReplySources.tsx) and why it
// ended early, if it did. One that failed or was stopped keeps its note and Try again.
// Its visuals and proposal cards are held until it ends (owner, 2026-11-18, spec P25: "charts show up while the agent
// is still working"): see bodyParts. A step or Based on piece that read the team's own data links to where it is (the
// Calendar's day, the Your data item or list), when `me` may open that page (spec P25 build note, 2026-11-18).

type BodyPart = Exclude<MessagePart, ProcessPart>;

/** A visual or a proposal card (a note's, an item's or an order's): what bodyParts holds until the reply ends. */
function isHeld(part: BodyPart): boolean {
  return part.type === 'visual' || part.type === 'proposal' || part.type === 'item' || part.type === 'order';
}

/** Deep equality of two JSON values, such as two visuals' specs. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/**
 * What the reply's body shows, in the model's order: its text (its thinking and tool calls are the Worked timeline,
 * an aside included), and, only once the reply is `complete` (it ended with `done`, whatever its stop reason), its
 * visuals and proposal cards among that text. While it streams they are held, so nothing appears above or between
 * the working steps; a reply that failed, was stopped or was interrupted saved nothing and never shows them. A visual
 * drawn again with the same spec in one reply shows once, where it was drawn last (beside the answer it ended with).
 * Live, read back after a reload and followed after a reattach, a reply reads the same once it ends.
 */
export function bodyParts(message: ChatMessage): BodyPart[] {
  const parts = message.parts.filter((part): part is BodyPart => !isProcessPart(part));
  if (message.state !== 'complete') return parts.filter((part) => !isHeld(part));
  return parts.filter((part, index) => part.type !== 'visual'
    || !parts.slice(index + 1).some((later) => later.type === 'visual' && sameValue(later.visual, part.visual)));
}

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
  /** The page's open timelines (workedOpen.ts). */
  workedOpen: WorkedOpen;
  /** Who is reading (GET /api/me), for the links to the team's data; none without it. */
  me?: MeResponse | null;
}): React.JSX.Element {
  const { message, chat } = props;
  const me = props.me ?? null;
  const hrefOf: HrefOf = (target: DataTarget | null) => targetHref(target, props.locationId, me);
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
  // A reply that streamed here fades its held visuals and cards in when it ends; one read back shows them at once.
  const [streamedHere, setStreamedHere] = useState(live);
  if (live && !streamedHere) setStreamedHere(true);
  // A live reply's node is known from its turn's first event, before the reply has it.
  const [open, setOpen] = useWorkedOpen(props.workedOpen, message.key, [message.nodeId, live ? chat.state.turn?.nodes?.reply ?? null : null]);

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
      <Worked
        live={live}
        startedAt={message.startedAt ?? mounted}
        seconds={endedFor}
        parts={process}
        ctx={props.ctx}
        open={open}
        onOpen={setOpen}
        hrefOf={hrefOf}
      />
      {bodyParts(message).map((part) => {
        if (part.type === 'text') return <Markdown key={part.key} source={part.text} caret={part.key === caretOn} />;
        let held: React.JSX.Element;
        if (part.type === 'visual') held = <VisualView visual={part.visual} />;
        else if (part.type === 'item') held = <ItemProposalCard card={part.card} locationId={props.locationId} actions={chat} readOnlyId={props.readOnlyId} />;
        else if (part.type === 'order') held = <OrderProposalCard card={part.card} locationId={props.locationId} readOnlyId={props.readOnlyId} />;
        else held = <ProposalCard card={part.card} locationId={props.locationId} actions={chat} readOnlyId={props.readOnlyId} />;
        return streamedHere ? <FadeIn key={part.key}>{held}</FadeIn> : <Fragment key={part.key}>{held}</Fragment>;
      })}
      {complete && message.parts.length > 0 ? (
        <>
          <ReplyActions message={message} newest={props.newest} show={props.actions} chat={chat} canAct={props.canAct} readOnlyId={props.readOnlyId}>
            {versions}
          </ReplyActions>
          <Text style={styles.basedOn}>
            {basedOnParts(stepsOf(message), props.ctx).map((part, index) => {
              if (typeof part === 'string') return part;
              const href = hrefOf(part.target);
              return href === null ? part.text : <Link key={index} href={href} style={styles.basedOnLink}>{part.text}</Link>;
            })}
          </Text>
          <ReplySources sources={message.sources} />
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
  basedOnLink: { ...inlineTarget, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  note: { ...theme.type.small, color: c.text3 },
});
