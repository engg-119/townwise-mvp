import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { useReducedMotion } from '../../motion';
import { localToday } from '../../portal/locations/dates';
import { locationHref } from '../../portal/routing';
import { Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine, ReadOnlyLine } from '../../portal/ui/feedback';
import { Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import { INITIAL_PIN, nextPin, type PinEvent, type PinState } from '../scrollPin';
import { suggestionsFor } from '../suggestions';
import { readsLine, toolLine, type ToolContext } from '../tools';
import { canSend, stepsOf, type TuningChat } from '../useTuningChat';
import { Composer, type ComposerHandle } from './Composer';
import { ConversationHeader } from './ConversationMenu';
import { MessageView } from './MessageView';
import { Suggestions } from './Suggestions';
import { FadeIn } from './ToolGroup';

// The chatbox (spec P25): the header with Conversations and New chat, the message log, the
// suggestions of an empty conversation, and the composer docked under the log. The log is `role="log"` but not a
// live region (streamed tokens would chatter); a separate polite region says when TownwiseAI starts replying, each
// thing it starts reading, and when it has replied or why it couldn't. The log keeps its end in view while pinned
// (scrollPin.ts), and shows Latest when a reply grows below the view.

export interface AgentChatContext extends ToolContext {
  locationId: string;
  locationName: string;
  orgName: string;
  hasSales: boolean;
  hasTownProfile: boolean;
  coverage: { dayCount: number; lastDate: string | null };
}

type Scroller = React.ComponentRef<typeof ScrollView>;

/** What the live region says, from the chat's state: one sentence at a time, never the streamed text. */
function announcementOf(chat: TuningChat, ctx: ToolContext): string {
  const { state } = chat;
  const reply = state.messages.at(-1);
  if (reply?.role !== 'assistant') return '';
  if (reply.state === 'streaming') {
    const running = stepsOf(reply).filter((step) => step.state === 'running').at(-1);
    return running === undefined ? 'TownwiseAI is replying' : toolLine(running, ctx).sentence;
  }
  if (reply.state === 'complete') return 'TownwiseAI replied';
  // The reason is on the page (the error, read out as an alert, or the note under the reply).
  return reply.state === 'stopped' ? 'You stopped the reply' : 'TownwiseAI’s reply didn’t finish';
}

/** "TownwiseAI is thinking…" while nothing is being written or read: before anything arrives, and between steps. */
function isThinking(chat: TuningChat): boolean {
  const reply = chat.state.messages.at(-1);
  if (!chat.state.streaming || reply?.role !== 'assistant' || reply.state !== 'streaming') return false;
  const last = reply.parts.at(-1);
  if (last === undefined) return true;
  return last.type === 'tools' && last.steps.every((step) => step.state !== 'running');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function AgentChat(props: {
  chat: TuningChat;
  ctx: AgentChatContext;
  /** On phones, the location's compact header and the section switch, at the top of what scrolls. */
  top: React.ReactNode;
  readOnlyId: string | null;
  readOnlyLine: string;
}): React.JSX.Element {
  const { chat, ctx } = props;
  const { state } = chat;
  const reduced = useReducedMotion();
  const scroll = useRef<Scroller>(null);
  const composer = useRef<ComposerHandle>(null);
  // The pin lives in a ref (every scroll event moves it); only whether Latest shows is drawn.
  const pin = useRef<PinState>(INITIAL_PIN);
  const [behind, setBehind] = useState(false);
  const announcement = announcementOf(chat, ctx);

  useEffect(() => {
    if (announcement !== '' && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);

  function apply(event: PinEvent): void {
    const { state: next, scroll: move } = nextPin(pin.current, event);
    pin.current = next;
    setBehind(next.behind);
    if (move === 'jump') scroll.current?.scrollToEnd({ animated: false });
    if (move === 'move') scroll.current?.scrollToEnd({ animated: reduced === false });
  }

  function send(run: () => void): void {
    run();
    apply({ type: 'send' });
  }

  function opened(run: () => void): void {
    run();
    apply({ type: 'opened' });
  }

  if (state.status === 'loading') return <View style={styles.fill}>{props.top}<LoadingLine text="Loading TownwiseAI…" /></View>;
  if (state.status === 'not_found') return <View style={styles.fill}>{props.top}<Text style={styles.body}>This location wasn’t found.</Text></View>;
  if (state.status === 'failed') {
    return (
      <View style={styles.fill}>
        {props.top}
        <ErrorNotice message={state.loadError ?? 'Something went wrong.'} onRetry={chat.reload} />
      </View>
    );
  }
  if (!state.enabled) {
    return (
      <View style={styles.fill}>
        {props.top}
        <Text style={styles.body}>TownwiseAI isn’t turned on yet.</Text>
        <ReadOnlyLine text={props.readOnlyLine} {...(props.readOnlyId === null ? {} : { nativeID: props.readOnlyId })} />
      </View>
    );
  }

  const title = state.conversationId === null
    ? 'New conversation'
    : (state.conversations.find((conversation) => conversation.id === state.conversationId)?.title ?? 'Conversation');
  const empty = state.messages.length === 0 && !state.conversationLoading;
  const suggestions = suggestionsFor({ coverage: ctx.coverage, today: localToday(), townName: ctx.town, hasTownProfile: ctx.hasTownProfile });
  const exhausted = state.budget?.exhausted === true;
  const month = MONTHS[Number(state.budget?.month.slice(5, 7) ?? '1') - 1] ?? '';
  const nextMonth = MONTHS[Number(state.budget?.month.slice(5, 7) ?? '1') % 12]?.slice(0, 3) ?? '';

  return (
    <View style={styles.fill}>
      <View style={styles.fill}>
      <ScrollView
        ref={scroll}
        testID="chat-thread"
        role="log"
        aria-label="Conversation with TownwiseAI"
        style={styles.fill}
        contentContainerStyle={styles.thread}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          apply({ type: 'scroll', y: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height });
        }}
        onContentSizeChange={(_width, height) => { apply({ type: 'contentGrew', contentHeight: height }); }}
      >
        {props.top}
        <ConversationHeader
          title={title}
          conversations={state.conversations}
          openId={state.conversationId}
          streaming={state.streaming}
          readOnlyId={props.readOnlyId}
          onOpen={(id) => { opened(() => { chat.openConversation(id); }); }}
          onNew={() => { opened(chat.newConversation); }}
          onDelete={chat.deleteConversation}
        />
        {state.conversationLoading ? <Text style={styles.muted}>Loading the conversation…</Text> : null}
        {empty ? (
          <View style={styles.empty}>
            <Heading>{`Ask TownwiseAI about ${ctx.locationName}`}</Heading>
            {ctx.hasSales ? (
              <Text style={styles.body}>
                {`It reads ${readsLine(ctx)}, and shows you each thing it reads. It suggests notes; you decide what’s saved.`}
              </Text>
            ) : (
              <View style={styles.noSales}>
                <Text style={styles.body}>
                  {`You haven’t uploaded sales yet, so TownwiseAI can only use your notes and ${ctx.town}’s town profile.`}
                </Text>
                {Platform.OS === 'web' ? <LinkButton href={locationHref(ctx.locationId, 'upload')} label="Upload sales" /> : null}
              </View>
            )}
            <Suggestions
              items={suggestions}
              readOnlyId={props.readOnlyId}
              busy={state.streaming || exhausted}
              onAsk={(text) => { send(() => { chat.ask(text); }); }}
              onTell={(text) => {
                chat.setDraft(text);
                composer.current?.focus();
              }}
            />
          </View>
        ) : null}
        {state.messages.map((message) => (
          <MessageView
            key={message.key}
            message={message}
            ctx={ctx}
            locationId={ctx.locationId}
            actions={chat}
            readOnlyId={props.readOnlyId}
            canRetry={!state.streaming && !exhausted}
            onRetry={(key) => { send(() => { chat.retry(key); }); }}
          />
        ))}
        {isThinking(chat) ? <Text style={styles.status}>TownwiseAI is thinking…</Text> : null}
      </ScrollView>
      {behind ? (
        <View style={styles.latest}>
          <FadeIn duration={theme.motion.select}>
            <Button variant="outline" label="Latest" onPress={() => { apply({ type: 'latest' }); }} />
          </FadeIn>
        </View>
      ) : null}
      </View>
      <View style={styles.live} aria-live="polite" accessibilityLiveRegion="polite">
        <Text>{announcement}</Text>
      </View>
      {state.error === null ? null : (
        <View style={styles.error}>
          <ErrorNotice message={state.error} />
          {state.error.startsWith('This conversation is full') && props.readOnlyId === null ? (
            <Button variant="link" label="New chat" onPress={chat.newConversation} />
          ) : null}
        </View>
      )}
      <ReadOnlyLine text={props.readOnlyLine} {...(props.readOnlyId === null ? {} : { nativeID: props.readOnlyId })} />
      {exhausted ? (
        <View style={styles.spent}>
          <Text style={styles.body}>
            {`${ctx.orgName} has used its TownwiseAI budget for ${month}. It comes back on ${nextMonth} 1. Home and Analytics don’t depend on it.`}
          </Text>
        </View>
      ) : (
        <Composer
          focusRef={composer}
          draft={state.draft}
          onChange={chat.setDraft}
          streaming={state.streaming}
          canSend={canSend(state)}
          onSend={() => { send(chat.send); }}
          onStop={chat.stop}
          help={`Leave out guest names. TownwiseAI answers from ${readsLine(ctx)}.`}
          readOnlyId={props.readOnlyId}
        />
      )}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  thread: { gap: theme.space[5], paddingBottom: theme.space[4] },
  body: { ...theme.type.sub, color: c.text2 },
  muted: { ...theme.type.small, color: c.text3 },
  status: { ...theme.type.small, color: c.text2 },
  empty: { gap: theme.space[4], paddingTop: theme.space[4] },
  noSales: { gap: theme.space[2], alignItems: 'flex-start' },
  latest: { position: 'absolute', right: 0, bottom: theme.space[3], zIndex: 1, backgroundColor: c.ground },
  // Read by screen readers, not drawn.
  live: { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden' },
  error: { gap: theme.space[2], paddingTop: theme.space[2] },
  spent: {
    padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border, marginTop: theme.space[3],
  },
});
