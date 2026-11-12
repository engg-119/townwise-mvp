import { Fragment, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { useReducedMotion } from '../../motion';
import { localToday } from '../../portal/locations/dates';
import { NamePrompt } from '../../portal/profile/NamePrompt';
import { locationHref } from '../../portal/routing';
import { Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine, ReadOnlyLine } from '../../portal/ui/feedback';
import { Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import { INITIAL_PIN, nextPin, type PinEvent, type PinState } from '../scrollPin';
import { nextFallback, suggestionsFor } from '../suggestions';
import { readsLine, toolLine, type ToolContext } from '../tools';
import { canSend, messageText, stepsOf, type ChatMessage, type TuningChat } from '../useTuningChat';
import { budgetLines } from './AgentSidePanel';
import { ChatHeader, PanelButton } from './ChatHeader';
import { Composer, type ComposerHandle } from './Composer';
import { focusLost } from './controls';
import { NextChips } from './NextChips';
import { ReplyView } from './ReplyView';
import { Suggestions } from './Suggestions';
import { FadeIn } from './ToolGroup';
import { UserMessage } from './UserMessage';

// The TownwiseAI chat page (spec P25, D26): the one-time name prompt, the header (History,
// New chat and Questions and activity; no title), then the landing of an empty conversation (one centered column: what to ask,
// what TownwiseAI reads, the composer and the quick-start chips) or the thread, with the composer docked under it.
// Above the composer: the 80% budget line, the error and the read-only line; once the budget is used up, a sentence
// takes the composer's place. Messages and the composer share one centered column, at most 760px wide. The thread is
// `role="log"` but not a live region (streamed tokens would chatter); one polite region outside the messages says
// when TownwiseAI starts replying, each thing it starts reading, when it has replied or why it couldn't, and which
// version shows after a switch. The log keeps its end in view while pinned (scrollPin.ts), and shows Latest when a
// reply grows below the view. On phones the location's compact header (`top`) scrolls with the landing or thread.

export interface AgentChatContext extends ToolContext {
  locationId: string;
  locationName: string;
  orgName: string;
  hasSales: boolean;
  /** Every upload holding days is turned off on Your data (D28), so `hasSales` is false for that reason. */
  uploadsOff?: boolean;
  coverage: { dayCount: number; lastDate: string | null };
}

type Scroller = React.ComponentRef<typeof ScrollView>;
type Host = React.ComponentRef<typeof View>;

/**
 * What the live region says, from the chat's state: one sentence at a time, never the streamed text. Only a reply to
 * a message sent on this visit is news: `before` holds the keys of the messages shown when it was sent (null when
 * nothing has been sent since the conversation opened or a version was switched), so a reply opened from history, a
 * version shown, or the one left when a turn is taken back, says nothing.
 */
function announcementOf(chat: TuningChat, ctx: ToolContext, before: ReadonlySet<string> | null): string {
  const { state } = chat;
  const reply = state.messages.at(-1);
  if (reply?.role !== 'assistant' || before === null || before.has(reply.key)) return '';
  if (reply.state === 'streaming') {
    const running = stepsOf(reply).filter((step) => step.state === 'running').at(-1);
    return running === undefined ? 'TownwiseAI is replying' : toolLine(running, ctx).sentence;
  }
  if (reply.state === 'complete') return 'TownwiseAI replied';
  // The reason is on the page (the error, read out as an alert, or the note under the reply).
  return reply.state === 'stopped' ? 'You stopped the reply' : 'TownwiseAI’s reply didn’t finish';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The docked composer's last rotating example, once there are sales to tell about. */
const SATURDAY = 'Tell me about last Saturday';

export function AgentChat(props: {
  chat: TuningChat;
  ctx: AgentChatContext;
  /** On phones, the location's compact header, at the top of what scrolls; null on wider screens. */
  top: React.ReactNode;
  readOnlyId: string | null;
  readOnlyLine: string;
  /** Questions and activity is open: a column from 1024px, a sheet below (the page draws it). */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** The open questions, for the panel button; null while they load. */
  openQuestions: number | null;
  /** The panel button, where the panel sheet returns focus (web). */
  panelButtonRef?: React.RefObject<Host | null>;
}): React.JSX.Element {
  const { chat, ctx } = props;
  const { state } = chat;
  const reduced = useReducedMotion();
  const scroll = useRef<Scroller>(null);
  const composer = useRef<ComposerHandle>(null);
  // The pin lives in a ref (every scroll event moves it); only whether Latest shows is drawn.
  const pin = useRef<PinState>(INITIAL_PIN);
  const [behind, setBehind] = useState(false);
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  // Words a message view gave the region ("Showing version 2 of 3."); `n` grows with each, so a repeat is news too.
  const [said, setSaid] = useState<{ words: string; n: number } | null>(null);
  const saidCount = useRef(0);
  // A send from the landing, and what sent it: the composer moves under the thread, and focus follows it.
  const docking = useRef<'composer' | 'other' | null>(null);
  // What docked the composer, until another conversation shows: if the first turn is taken back (refused, or the
  // connection failed before anything arrived), the landing returns, and focus goes back to its composer.
  const docked = useRef<'composer' | 'other' | null>(null);
  // A conversation opened, started or deleted by the person: if that swaps the landing and the thread, what is drawn
  // in both (the notices, and on phones the header) is drawn anew, and the control they used goes with it.
  const switched = useRef(false);
  const landing = state.status === 'ready' && state.enabled && state.messages.length === 0 && !state.conversationLoading;
  const spoken = said ?? { words: announcementOf(chat, ctx, before), n: 0 };

  useEffect(() => {
    if (spoken.words !== '' && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(spoken.words);
  }, [spoken.words, spoken.n]);

  useEffect(() => {
    const from = landing ? docked.current : docking.current;
    const moved = switched.current;
    docking.current = null;
    docked.current = landing ? null : from;
    switched.current = false;
    if (from === null) {
      // On web, if focus went with that control, the composer now shown takes it; never on opening the page.
      if (moved && Platform.OS === 'web' && focusLost()) composer.current?.focus();
      return;
    }
    // The composer or chip the person used went with the landing (or the docked composer with the thread, when the
    // first turn was taken back). On web the composer now shown takes focus only if focus went with them (not if the
    // person has since put it elsewhere); on native only after a send from the composer, so a chip doesn't open the
    // keyboard.
    if (Platform.OS === 'web' ? focusLost() : from === 'composer') composer.current?.focus();
  }, [landing]);

  function apply(event: PinEvent): void {
    const { state: next, scroll: move } = nextPin(pin.current, event);
    pin.current = next;
    setBehind(next.behind);
    if (move === 'jump') scroll.current?.scrollToEnd({ animated: false });
    if (move === 'move') scroll.current?.scrollToEnd({ animated: reduced === false });
  }

  function send(run: () => void, from: 'composer' | 'other' = 'other'): void {
    docking.current = landing ? from : null;
    setBefore(new Set(state.messages.map((message) => message.key)));
    setSaid(null);
    run();
    apply({ type: 'send' });
  }

  function opened(run: () => void): void {
    docking.current = null;
    docked.current = null;
    switched.current = true;
    setBefore(null);
    setSaid(null);
    run();
    apply({ type: 'opened' });
  }

  function announce(words: string): void {
    saidCount.current += 1;
    setSaid({ words, n: saidCount.current });
  }

  // The message views act through the chat with the page's bookkeeping: an edit or a regenerate is a send (its reply
  // is news, and the log follows it); a version switch draws every message anew, and none of that is news.
  const actions: TuningChat = {
    ...chat,
    editMessage: (key, content) => { send(() => { chat.editMessage(key, content); }); },
    regenerate: (key) => { send(() => { chat.regenerate(key); }); },
    showVersion: (key, step) => {
      setBefore(null);
      setSaid(null);
      chat.showVersion(key, step);
    },
  };

  const readOnlyLine = <ReadOnlyLine text={props.readOnlyLine} {...(props.readOnlyId === null ? {} : { nativeID: props.readOnlyId })} />;
  // TownwiseAI off or unreadable still has its panel: the questions and activity don't need the chat (spec 10.12).
  const panelOnly = (
    <View style={styles.panelBar}>
      <PanelButton
        open={props.panelOpen}
        openQuestions={props.openQuestions}
        onPress={props.onTogglePanel}
        {...(props.panelButtonRef === undefined ? {} : { buttonRef: props.panelButtonRef })}
      />
    </View>
  );

  if (state.status === 'loading') return <View style={styles.fill}>{props.top}<LoadingLine text="Loading TownwiseAI…" /></View>;
  if (state.status === 'not_found') return <View style={styles.fill}>{props.top}<Text style={styles.body}>This location wasn’t found.</Text></View>;
  if (state.status === 'failed') {
    return (
      <View style={styles.fill}>
        {props.top}
        {panelOnly}
        <ErrorNotice message={state.loadError ?? 'Something went wrong.'} onRetry={chat.reload} />
      </View>
    );
  }
  if (!state.enabled) {
    return (
      <View style={styles.fill}>
        {props.top}
        {panelOnly}
        <Text style={styles.body}>TownwiseAI isn’t turned on yet.</Text>
        {readOnlyLine}
      </View>
    );
  }

  const today = localToday();
  const suggestions = suggestionsFor({ coverage: ctx.coverage, today, townName: ctx.town, hasTownProfile: ctx.hasTownProfile });
  const examples = [...suggestions.flatMap((item) => (item.kind === 'ask' ? [item.text] : [])), ...(ctx.hasSales ? [SATURDAY] : [])];
  const exhausted = state.budget?.exhausted === true;
  const warning = state.budget === null ? null : budgetLines(state.budget).warning;
  const month = MONTHS[Number(state.budget?.month.slice(5, 7) ?? '1') - 1] ?? '';
  const nextMonth = MONTHS[Number(state.budget?.month.slice(5, 7) ?? '1') % 12]?.slice(0, 3) ?? '';
  // Edit, the versions, the reply actions and Try again wait while a reply streams or a version or conversation loads.
  const canAct = !state.streaming && !state.switching && !state.conversationLoading;
  // While a reply streams the button is Stop, or Stop and send once there's text, which needs only the text.
  const sendable = state.streaming ? state.draft.trim() !== '' && !state.switching && !state.conversationLoading : canSend(state);

  /** The three next questions under the newest settled reply: the model's, else three by the fixed rules. */
  function nextOf(reply: ChatMessage, asked: ChatMessage | undefined): readonly string[] {
    if (reply.next !== null && reply.next.length === 3) return reply.next;
    return nextFallback({
      steps: stepsOf(reply),
      hasVisual: reply.parts.some((part) => part.type === 'visual'),
      coverage: ctx.coverage,
      today,
      townName: ctx.town,
      hasTownProfile: ctx.hasTownProfile,
      lastAsked: asked?.role === 'user' ? messageText(asked) : '',
    });
  }

  const header = (
    <ChatHeader
      conversations={state.conversations}
      openId={state.conversationId}
      streaming={state.streaming}
      readOnlyId={props.readOnlyId}
      panelOpen={props.panelOpen}
      openQuestions={props.openQuestions}
      onOpen={(id) => { opened(() => { chat.openConversation(id); }); }}
      onNew={() => { opened(chat.newConversation); }}
      onDelete={(id) => {
        // Deleting the open conversation shows the landing, which is not a turn taken back.
        if (id === state.conversationId) {
          docked.current = null;
          switched.current = true;
        }
        return chat.deleteConversation(id);
      }}
      onRename={chat.rename}
      onTogglePanel={props.onTogglePanel}
      {...(props.panelButtonRef === undefined ? {} : { panelButtonRef: props.panelButtonRef })}
    />
  );
  // On phones this scrolls with the landing or the thread, under the location's compact header.
  const lead = <>{props.top}<NamePrompt />{header}</>;

  // What sits right above the composer, wherever it is.
  const notices = (
    <>
      {warning === null ? null : <Text style={styles.warning}>{warning}</Text>}
      {state.error === null ? null : (
        <View style={styles.error}>
          <ErrorNotice message={state.error} />
          {state.error.startsWith('This conversation is full') && props.readOnlyId === null ? (
            <Button variant="link" label="New chat" onPress={() => { opened(chat.newConversation); }} />
          ) : null}
        </View>
      )}
      {readOnlyLine}
    </>
  );

  function composerAt(placement: 'landing' | 'dock'): React.JSX.Element {
    if (exhausted) {
      return (
        <View style={styles.spent}>
          <Text style={styles.body}>
            {`${ctx.orgName} has used its TownwiseAI budget for ${month}. It comes back on ${nextMonth} 1. Home and Analytics don’t depend on it.`}
          </Text>
        </View>
      );
    }
    return (
      <Composer
        focusRef={composer}
        draft={state.draft}
        onChange={chat.setDraft}
        streaming={state.streaming}
        canSend={sendable}
        onSend={() => { send(chat.send, 'composer'); }}
        onStop={chat.stop}
        onStopAndSend={() => { send(chat.stopAndSend, 'composer'); }}
        help={`Leave out guest names. TownwiseAI answers from ${readsLine(ctx)}.`}
        // On the landing the chips under it already show what to ask; under view-as nothing fills the composer.
        examples={placement === 'dock' && props.readOnlyId === null ? examples : []}
        readOnlyId={props.readOnlyId}
        placement={placement}
      />
    );
  }

  const last = state.messages.length - 1;
  const body = landing ? (
    <ScrollView testID="chat-landing" style={styles.fill} contentContainerStyle={styles.landingScroll} keyboardShouldPersistTaps="handled">
      {props.top === null ? null : lead}
      <View testID="chat-landing-column" style={styles.landing}>
        <Heading>{`Ask TownwiseAI about ${ctx.locationName}`}</Heading>
        {ctx.hasSales ? (
          <Text style={styles.body}>
            {`It reads ${readsLine(ctx)}, and shows you each thing it reads. It suggests notes; you decide what’s saved.`}
          </Text>
        ) : (
          <View style={styles.noSales}>
            <Text style={styles.body}>
              {ctx.uploadsOff === true
                ? `Every sales upload for this location is turned off, so TownwiseAI can only use ${readsLine(ctx, { sales: false })}. Turn one back on in Your data.`
                : `You haven’t uploaded sales yet, so TownwiseAI can only use ${readsLine(ctx, { sales: false })}.`}
            </Text>
            {ctx.uploadsOff === true
              ? <LinkButton href={locationHref(ctx.locationId, 'data')} label="Open Your data" />
              : Platform.OS === 'web' ? <LinkButton href={locationHref(ctx.locationId, 'upload')} label="Upload sales" /> : null}
          </View>
        )}
        <View>
          {notices}
          {composerAt('landing')}
        </View>
        <Suggestions
          items={suggestions}
          readOnlyId={props.readOnlyId}
          busy={!canAct || exhausted}
          onAsk={(text) => { send(() => { chat.ask(text); }); }}
          onTell={(text) => {
            chat.setDraft(text);
            composer.current?.focus();
          }}
        />
      </View>
    </ScrollView>
  ) : (
    <>
      <View style={styles.fill}>
        <ScrollView
          ref={scroll}
          testID="chat-thread"
          role="log"
          // A log is polite by default; this one is not live, so streamed text and what scrolls with it go unread.
          aria-live="off"
          aria-label="Conversation with TownwiseAI"
          style={styles.fill}
          contentContainerStyle={[styles.thread, props.top === null ? styles.threadUnderHeader : null]}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            apply({ type: 'scroll', y: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height });
          }}
          onContentSizeChange={(_width, height) => { apply({ type: 'contentGrew', contentHeight: height }); }}
        >
          {props.top === null ? null : lead}
          <View testID="chat-column" style={styles.column}>
            {state.conversationLoading ? <Text style={styles.muted}>Loading the conversation…</Text> : null}
            {state.messages.map((message, index) => {
              if (message.role === 'user') {
                return (
                  <UserMessage
                    key={message.key}
                    message={message}
                    tree={state.tree}
                    chat={actions}
                    readOnlyId={props.readOnlyId}
                    busy={!canAct}
                    onEdited={() => { composer.current?.focus(); }}
                    onAnnounce={announce}
                  />
                );
              }
              const newest = index === last;
              return (
                <Fragment key={message.key}>
                  <ReplyView
                    message={message}
                    ctx={ctx}
                    tree={state.tree}
                    newest={newest}
                    chat={actions}
                    locationId={ctx.locationId}
                    readOnlyId={props.readOnlyId}
                    canAct={canAct}
                    onRetry={(key) => { send(() => { chat.retry(key); }); }}
                    onAnnounce={announce}
                  />
                  {newest && message.state === 'complete' ? (
                    <NextChips
                      prompts={nextOf(message, state.messages[index - 1])}
                      disabled={!canAct || exhausted}
                      readOnlyId={props.readOnlyId}
                      onAsk={(text) => {
                        send(() => { chat.ask(text); });
                        // The chips go with the reply above them, now not the newest: on web focus goes where Stop is.
                        if (Platform.OS === 'web') composer.current?.focus();
                      }}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </View>
        </ScrollView>
        {behind ? (
          <View style={styles.latest}>
            <FadeIn duration={theme.motion.select}>
              <Button variant="outline" label="Latest" onPress={() => { apply({ type: 'latest' }); }} />
            </FadeIn>
          </View>
        ) : null}
      </View>
      <View style={styles.dock}>
        {notices}
        {composerAt('dock')}
      </View>
    </>
  );

  return (
    <View style={styles.fill}>
      {props.top === null ? lead : null}
      {body}
      <View testID="chat-live" style={styles.live} aria-live="polite" accessibilityLiveRegion="polite">
        <Text key={spoken.n}>{spoken.words}</Text>
      </View>
    </View>
  );
}

const c = theme.color;
/** The landing's and the thread's column (spec P25). */
const COLUMN = 760;

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  panelBar: {
    flexDirection: 'row', justifyContent: 'flex-end', borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border,
    paddingBottom: theme.space[2], marginBottom: theme.space[4],
  },
  landingScroll: { flexGrow: 1 },
  landing: {
    flexGrow: 1, justifyContent: 'center', width: '100%', maxWidth: COLUMN, minWidth: 0, alignSelf: 'center', gap: theme.space[4],
    paddingVertical: theme.space[6],
  },
  thread: { gap: theme.space[5], paddingBottom: theme.space[4] },
  threadUnderHeader: { paddingTop: theme.space[4] },
  column: { width: '100%', maxWidth: COLUMN, minWidth: 0, alignSelf: 'center', gap: theme.space[5] },
  dock: { width: '100%', maxWidth: COLUMN, minWidth: 0, alignSelf: 'center' },
  body: { ...theme.type.sub, color: c.text2 },
  muted: { ...theme.type.small, color: c.text3 },
  warning: { ...theme.type.small, color: c.text2, paddingTop: theme.space[2] },
  noSales: { gap: theme.space[2], alignItems: 'flex-start' },
  latest: { position: 'absolute', right: 0, bottom: theme.space[3], zIndex: 1, backgroundColor: c.ground },
  // Read by screen readers, not drawn.
  live: { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden' },
  error: { gap: theme.space[2], paddingTop: theme.space[2] },
  spent: {
    padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border, marginTop: theme.space[3],
  },
});
