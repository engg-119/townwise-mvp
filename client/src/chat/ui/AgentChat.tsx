import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle,
} from 'react-native';

import { useReducedMotion } from '../../motion';
import { localToday } from '../../portal/locations/dates';
import { useOptionalPortal } from '../../portal/PortalProvider';
import { locationHref } from '../../portal/routing';
import { Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine, ReadOnlyLine } from '../../portal/ui/feedback';
import { Skeleton, SkeletonText } from '../../portal/skeleton/kit';
import { Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import { formatCount } from '../format';
import { INITIAL_PIN, nextPin, type PinEvent, type PinState } from '../scrollPin';
import { nextFallback, suggestionsFor } from '../suggestions';
import { readsLine, toolLine, type ToolContext } from '../tools';
import { openQuestions, type AgentPanelState } from '../useAgentPanel';
import type { MessageAttachment } from '../api';
import { canSend, messageText, stepsOf, type ChatMessage, type Telling, type TuningChat, type TuningChatState } from '../useTuningChat';
import { budgetLines } from './AgentSidePanel';
import { ChatDrop } from './ChatDrop';
import { ChatHeader, PanelButton } from './ChatHeader';
import { Composer, type ComposerHandle } from './Composer';
import { useComposerFiles } from './ComposerFiles';
import { focusLost } from './controls';
import { NextChips } from './NextChips';
import { QuestionCard, questionChatOf } from './QuestionCard';
import { ReplyView } from './ReplyView';
import { Suggestions } from './Suggestions';
import { FadeIn } from './ToolGroup';
import { UserMessage } from './UserMessage';
import { workedOpenStore } from './workedOpen';

// The TownwiseAI chat page (spec P25, D26): the header (History,
// New chat and Questions and activity; no title), then the landing of an empty conversation (one centered column: what to ask,
// what TownwiseAI reads, the composer, the quick-start chips and TownwiseAI's questions, the panel's cards sharing its
// state) or the thread, with the composer docked over its
// bottom edge. The thread runs the full height and scrolls under the dock: what passes shows above the box and at its
// top corners, and the ground hides it from the box's middle down (from the dock's top while a line sits above the
// composer). The thread keeps room at its end as tall as the dock, measured, so its last message scrolls clear of it.
// Above the composer: the 80% budget line, the error and the read-only line; once the budget is used up, a sentence
// takes the composer's place. Messages and the composer share one centered column, at most 760px wide. The thread is
// `role="log"` but not a live region (streamed tokens would chatter); one polite region outside the messages says
// when TownwiseAI starts replying, each thing it starts reading, when it has replied or why it couldn't, and which
// version shows after a switch (and, while a saved conversation loads, its skeleton's “Loading the conversation…”). The log keeps its end in view while pinned (scrollPin.ts), and shows Latest, above
// the dock, when a reply grows below the view; the dock growing or shrinking moves the end, never the pin. The header
// sits under the portal's top bar on every screen, above what scrolls.
//
// Files (web, D36): the composer's + and a drop anywhere on the page (ChatDrop, drawn after the body and outside the
// dock) attach files to the message as chips inside the composer's box (ComposerFiles). Send waits while one
// uploads, carries the ready ones, and gives them back if the turn is taken back; each conversation keeps its own.

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

/** What the page does through the chat for the panel's question cards. */
export interface AgentChatHandle {
  /**
   * Sends a question's Something else… message in the conversation shown (the landing starts one), as a chip does
   * (TuningChat.tell). `focus`: on web focus goes to the composer at once (from the column; the sheet moves it there
   * when it closes).
   */
  tell: (message: string, telling: Telling, focus: boolean) => void;
  /** Focuses the composer, where focus goes when a question's message closes the panel sheet (web). */
  focusComposer: () => void;
}

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

/** Why files can't be attached now: the drop overlay says so while the drag is over the page. */
export const DROP_BLOCKED = {
  loading: 'TownwiseAI is still loading, so files can’t be attached yet.',
  off: 'TownwiseAI isn’t available here, so files can’t be attached.',
  viewAs: 'View-as is read-only, so files can’t be attached.',
  filesOff: 'File storage is off right now, so files can’t be attached.',
  budget: 'This month’s TownwiseAI budget is used up, so files can’t be attached.',
} as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The docked composer's last rotating example, once there are sales to tell about. */
const SATURDAY = 'Tell me about last Saturday';

/** An empty conversation, drawn as the landing: what to ask, the composer, the chips and TownwiseAI's questions. */
function isLanding(state: TuningChatState): boolean {
  return state.status === 'ready' && state.enabled && state.messages.length === 0 && !state.conversationLoading;
}

/** Whether the landing lists TownwiseAI's questions under its chips, so the panel's column beside it leaves them out. */
export function landingShowsQuestions(state: TuningChatState, panel: AgentPanelState): boolean {
  return isLanding(state) && panel.state.status === 'ready' && panel.state.data.questions.length > 0;
}

export function AgentChat(props: {
  chat: TuningChat;
  ctx: AgentChatContext;
  readOnlyId: string | null;
  readOnlyLine: string;
  /** Questions and activity is open: a column from 1024px, a sheet below (the page draws it). */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** The open questions, for the panel button; null while they load. */
  openQuestions: number | null;
  /** The panel button, where the panel sheet returns focus (web). */
  panelButtonRef?: React.RefObject<Host | null>;
  /** TownwiseAI's questions, also shown on the landing under the chips. */
  panel: AgentPanelState;
  handleRef?: React.Ref<AgentChatHandle>;
}): React.JSX.Element {
  const { chat, ctx } = props;
  const { state } = chat;
  const reduced = useReducedMotion();
  const scroll = useRef<Scroller>(null);
  const composer = useRef<ComposerHandle>(null);
  // The composer's + and the page's drop (web, stored files on): the files on the message, and the lines about them.
  const files = useComposerFiles(ctx.locationId, props.readOnlyId, () => { composer.current?.focus(); });
  const toldFiles = useRef(new Set<string>());
  // The pin lives in a ref (every scroll event moves it); only whether Latest shows is drawn.
  const pin = useRef<PinState>(INITIAL_PIN);
  const [behind, setBehind] = useState(false);
  // The docked composer's measured height (with the lines above it): the room the thread keeps at its end.
  const [dock, setDock] = useState(0);
  const dockWas = useRef(0);
  // On web, the width the thread's scrollbar takes (a classic one; an overlay one takes none): the dock stops short of
  // it, so the bar shows down to the bottom and the dock's column is centered over the thread's.
  const [bar, setBar] = useState(0);
  const [before, setBefore] = useState<ReadonlySet<string> | null>(null);
  // Words a message view gave the region ("Showing version 2 of 3."); `n` grows with each, so a repeat is news too.
  const [said, setSaid] = useState<{ words: string; n: number } | null>(null);
  const saidCount = useRef(0);
  // Which replies' timelines the person opened (workedOpen.ts): the page's, so a reply drawn again keeps its own.
  const [workedOpen] = useState(workedOpenStore);
  // Who is reading, for a reply's links to the team's own data (ReplyView); none outside the portal.
  const me = useOptionalPortal()?.me ?? null;
  // A send from the landing, and what sent it: the composer moves under the thread, and focus follows it.
  const docking = useRef<'composer' | 'other' | null>(null);
  // What docked the composer, until another conversation shows: if the first turn is taken back (refused, or the
  // connection failed before anything arrived), the landing returns, and focus goes back to its composer.
  const docked = useRef<'composer' | 'other' | null>(null);
  // A conversation opened, started or deleted by the person: if that swaps the landing and the thread, what is drawn
  // in both (the notices, and on phones the header) is drawn anew, and the control they used goes with it.
  const switched = useRef(false);
  const landing = isLanding(state);
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

  // The dock grew or shrank (a second line, Expand, a notice), and so did the room under the thread: a pinned thread
  // goes to its new end before it is drawn; an unpinned one stays where it is, so counted without that room (as the
  // pin counts it) it moved by the change, and where the pin last saw it moves with it.
  useLayoutEffect(() => {
    if (pin.current.pinned) scroll.current?.scrollToEnd({ animated: false });
    else pin.current = { ...pin.current, lastY: pin.current.lastY - (dock - dockWas.current) };
    dockWas.current = dock;
  }, [dock]);

  // The thread's content height, for the pin. On native, onContentSizeChange (below). On web, a ResizeObserver on the
  // content, whose callback runs after layout and before paint, so a pinned thread is at its end in the frame that grew
  // it: every frame of the timeline's 200ms open and close, a chart drawn, a reattached turn's first layout. (The
  // ScrollView's onContentSizeChange measures in a timeout on web, a frame late: each growing frame was drawn short of
  // the end, then moved.) `heard` is the latest render's, read when the observer fires.
  const thread = state.status === 'ready' && state.enabled && !landing;
  const heard = useRef<(height: number) => void>(() => undefined);
  useLayoutEffect(() => {
    heard.current = (height) => {
      measureBar();
      apply({ type: 'contentGrew', contentHeight: height - dockWas.current });
    };
  });
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !thread || typeof ResizeObserver !== 'function') return undefined;
    const node = scroll.current?.getScrollableNode() as unknown as HTMLElement | null | undefined;
    const content = node?.firstElementChild as HTMLElement | null | undefined;
    if (content == null) return undefined;
    const observer = new ResizeObserver(() => { heard.current(content.offsetHeight); });
    observer.observe(content);
    return () => { observer.disconnect(); };
  }, [thread]);

  function measureBar(): void {
    if (Platform.OS !== 'web') return;
    const node = scroll.current?.getScrollableNode() as unknown as HTMLElement | null | undefined;
    setBar(node ? node.offsetWidth - node.clientWidth : 0);
  }

  function apply(event: PinEvent): void {
    const { state: next, scroll: move } = nextPin(pin.current, event);
    pin.current = next;
    setBehind(next.behind);
    if (move === 'jump') scroll.current?.scrollToEnd({ animated: false });
    if (move === 'move') scroll.current?.scrollToEnd({ animated: reduced === false });
  }

  function send<T>(run: () => T, from: 'composer' | 'other' = 'other'): T {
    docking.current = landing ? from : null;
    setBefore(new Set(state.messages.map((message) => message.key)));
    setSaid(null);
    const result = run();
    apply({ type: 'send' });
    return result;
  }

  /** The composer's Send or Stop and send: the message's ready files go with it, and come back if it is taken back. */
  function sendFromComposer(go: (attachments: MessageAttachment[], returned: () => void) => void): void {
    const taken = files.take();
    send(() => { go(taken.attachments, taken.restore); }, 'composer');
  }

  // A question card's message: sent as a chip's is, and (`focus`) on web focus goes where Stop is, as after a next question.
  function tell(message: string, telling: Telling, focus: boolean): void {
    send(() => { chat.tell(message, telling); });
    if (focus && Platform.OS === 'web') composer.current?.focus();
  }

  useImperativeHandle(props.handleRef, () => ({ tell, focusComposer: () => { composer.current?.focus(); } }));

  /** The person opens conversation `to` (null: a new one): the composer's files stay with the one shown, as its draft does. */
  function opened(run: () => void, to: string | null): void {
    // Opening and New chat do nothing while a reply streams (useTuningChat), so the files stay too.
    if (!state.streaming) files.switchTo(state.conversationId, to);
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

  // A file attached to the message, or taken off it, is news once, in the polite region; one that couldn't be added
  // shows as an alert.
  useEffect(() => {
    for (const line of files.news) {
      if (toldFiles.current.has(line.key)) continue;
      toldFiles.current.add(line.key);
      announce(line.text);
    }
  });

  // Why a drop can't attach files now, in the overlay's words; null when it can.
  function dropBlocked(): string | null {
    if (state.status === 'loading' || files.available === null) return DROP_BLOCKED.loading;
    if (state.status !== 'ready' || !state.enabled) return DROP_BLOCKED.off;
    if (props.readOnlyId !== null) return DROP_BLOCKED.viewAs;
    if (!files.available) return DROP_BLOCKED.filesOff;
    if (state.budget?.exhausted === true) return DROP_BLOCKED.budget;
    return null;
  }
  const blocked = dropBlocked();
  const drop = (
    <ChatDrop
      blocked={blocked}
      onFiles={(dropped) => {
        // Past the 5 a message carries, the alert says how many weren't added.
        const taken = files.add(dropped);
        const [only] = dropped;
        if (taken === 1 && only !== undefined) announce(`Attaching ${only.name} to your message.`);
        else if (taken > 1) announce(`Attaching ${String(taken)} files to your message.`);
      }}
    />
  );

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

  // Every state of the page catches a drop of files, so the browser never opens one in its place.
  if (state.status === 'loading') return <View style={styles.fill}><LoadingLine text="Loading TownwiseAI…" />{drop}</View>;
  if (state.status === 'not_found') return <View style={styles.fill}><Text style={styles.body}>This location wasn’t found.</Text>{drop}</View>;
  if (state.status === 'failed') {
    return (
      <View style={styles.fill}>
        {panelOnly}
        <ErrorNotice message={state.loadError ?? 'Something went wrong.'} onRetry={chat.reload} />
        {drop}
      </View>
    );
  }
  if (!state.enabled) {
    return (
      <View style={styles.fill}>
        {panelOnly}
        <Text style={styles.body}>TownwiseAI isn’t turned on yet.</Text>
        {readOnlyLine}
        {drop}
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
  // While a reply streams the button is Stop, or Stop and send once there's text, which needs only the text. Either
  // waits while a file on the message still uploads.
  const sendable = !files.uploading && (state.streaming ? state.draft.trim() !== '' && !state.switching && !state.conversationLoading : canSend(state));

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
      onOpen={(id) => { opened(() => { chat.openConversation(id); }, id); }}
      onNew={() => { opened(chat.newConversation, null); }}
      onDelete={(id) => {
        // Deleting the open conversation shows the landing, which is not a turn taken back.
        const open = id === state.conversationId;
        if (open) {
          docked.current = null;
          switched.current = true;
        }
        // The landing's composer shows a new conversation's files.
        return chat.deleteConversation(id).then(() => { if (open) files.switchTo(id, null); });
      }}
      onRename={chat.rename}
      onTogglePanel={props.onTogglePanel}
      {...(props.panelButtonRef === undefined ? {} : { panelButtonRef: props.panelButtonRef })}
    />
  );
  
  // What sits right above the composer, wherever it is.
  const notices = (
    <>
      {warning === null ? null : <Text style={styles.warning}>{warning}</Text>}
      {files.alerts.map((line) => <ErrorNotice key={line.key} message={line.text} />)}
      {state.error === null ? null : (
        <View style={styles.error}>
          <ErrorNotice message={state.error} />
          {state.error.startsWith('This conversation is full') && props.readOnlyId === null ? (
            <Button variant="link" label="New chat" onPress={() => { opened(chat.newConversation, null); }} />
          ) : null}
        </View>
      )}
      {readOnlyLine}
    </>
  );
  const noticed = warning !== null || files.alerts.length > 0 || state.error !== null || props.readOnlyLine !== '';

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
        onSend={() => { sendFromComposer(chat.send); }}
        onStop={chat.stop}
        onStopAndSend={() => { sendFromComposer(chat.stopAndSend); }}
        help={`Leave out guest names. TownwiseAI answers from ${readsLine(ctx)}.`}
        // On the landing the chips under it already show what to ask; under view-as nothing fills the composer.
        examples={placement === 'dock' && props.readOnlyId === null ? examples : []}
        readOnlyId={props.readOnlyId}
        placement={placement}
        attached={files.count > 0}
        sendDescribedBy={files.waitId}
        {...(files.button === null ? {} : { leading: files.button })}
        {...(files.chips === null ? {} : { attachments: files.chips })}
      />
    );
  }

  // The panel's questions, under the chips: none while they load, when they can't be read, or when there are none.
  const asked = props.panel.state.status === 'ready' ? props.panel.state.data.questions : [];
  const open = openQuestions(props.panel);
  const questionChat = questionChatOf(state);
  const last = state.messages.length - 1;
  const body = landing ? (
    <ScrollView testID="chat-landing" style={styles.fill} contentContainerStyle={styles.landingScroll} keyboardShouldPersistTaps="handled">
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
        {asked.length === 0 ? null : (
          <View testID="chat-landing-questions" style={styles.questions}>
            <Heading>{`Questions for you${open !== null && open > 0 ? ` (${formatCount(open)})` : ''}`}</Heading>
            {asked.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                panel={props.panel}
                locationName={ctx.locationName}
                readOnlyId={props.readOnlyId}
                chat={questionChat}
                send={(message, ended) => { tell(message, { ended }, true); }}
                place="landing"
              />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  ) : (
    <View style={styles.fill}>
      <ScrollView
        ref={scroll}
        testID="chat-thread"
        role="log"
        // A log is polite by default; this one is not live, so streamed text and what scrolls with it go unread.
        aria-live="off"
        aria-label="Conversation with TownwiseAI"
        // On web, what takes focus in the thread is scrolled into view above the dock, never under it.
        style={[styles.fill, (Platform.OS === 'web' ? { scrollPaddingBottom: dock } : {}) as unknown as ViewStyle]}
        contentContainerStyle={[styles.thread, styles.threadUnderHeader, { paddingBottom: dock + theme.space[4] }]}
        scrollIndicatorInsets={{ bottom: dock }}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        // The pin counts the thread without the room kept for the dock (the offset and the content both less it), so
        // the distance from the end stays true and the dock growing or shrinking, which moves the end and a pinned
        // offset with it, is neither the person scrolling nor new content.
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const y = contentOffset.y - dock;
          // At its end a pinned thread was not scrolled up, whatever the pin last saw: that can be from before the
          // dock was measured (a fresh thread's first overflow) or from another conversation.
          if (pin.current.pinned && contentSize.height - layoutMeasurement.height - contentOffset.y <= 1) {
            pin.current = { ...pin.current, lastY: Math.min(pin.current.lastY, y) };
          }
          apply({ type: 'scroll', y, contentHeight: contentSize.height - dock, viewportHeight: layoutMeasurement.height });
        }}
        // Native's content height (web's is the ResizeObserver above). The content's width changes whenever the scrollbar
        // comes or goes, so the bar is measured with it.
        {...(Platform.OS === 'web' ? {} : {
          onContentSizeChange: (_width: number, height: number) => {
            measureBar();
            apply({ type: 'contentGrew', contentHeight: height - dock });
          },
        })}
      >
        <View testID="chat-column" style={styles.column}>
          {state.conversationLoading ? (
            <Skeleton name="conversation" label="Loading the conversation…">
              <SkeletonText type="small" width={200} />
            </Skeleton>
          ) : null}
          {state.messages.map((message, index) => {
            if (message.role === 'user') {
              return (
                <UserMessage
                  key={message.key}
                  message={message}
                  tree={state.tree}
                  chat={actions}
                  locationId={ctx.locationId}
                  readOnlyId={props.readOnlyId}
                  busy={!canAct}
                  actions={index === last ? 'always' : 'hover'}
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
                  actions={newest ? 'always' : 'hover'}
                  chat={actions}
                  locationId={ctx.locationId}
                  readOnlyId={props.readOnlyId}
                  canAct={canAct}
                  onRetry={(key) => { send(() => { chat.retry(key); }); }}
                  onAnnounce={announce}
                  workedOpen={workedOpen}
                  me={me}
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
        <View testID="chat-latest" style={[styles.latest, { bottom: dock + theme.space[3] }]}>
          <FadeIn duration={theme.motion.select}>
            <Button variant="outline" label="Latest" onPress={() => { apply({ type: 'latest' }); }} />
          </FadeIn>
        </View>
      ) : null}
      {/* Over the thread's bottom edge, short of its scrollbar. The dock and its column pass scrolls, wheels and presses
          on to the thread; the composer and the lines above it take their own. */}
      <View testID="chat-dock" style={[styles.dock, { right: bar }]} onLayout={(event: LayoutChangeEvent) => { setDock(event.nativeEvent.layout.height); }}>
        <View style={styles.dockColumn}>
          <View testID="chat-dock-skirt" style={[styles.skirt, noticed ? null : styles.skirtLow]} />
          {notices}
          {composerAt('dock')}
        </View>
      </View>
    </View>
  );

  return (
    <View style={styles.fill}>
      {header}
      {body}
      {/* After the body and outside the dock, so a drag never changes the dock's measured height. */}
      {drop}
      <View testID="chat-live" style={styles.live} aria-live="polite" accessibilityLiveRegion="polite">
        <Text key={spoken.n}>{spoken.words}</Text>
      </View>
    </View>
  );
}

const c = theme.color;
/** The landing's and the thread's column (spec P25). */
const COLUMN = 760;
/** The docked composer's top padding and half its 56px box (Composer.tsx): where the skirt starts with no line above it. */
const SKIRT_TOP = theme.space[3] + 28;

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
  thread: { gap: theme.space[5] },
  threadUnderHeader: { paddingTop: theme.space[4] },
  column: { width: '100%', maxWidth: COLUMN, minWidth: 0, alignSelf: 'center', gap: theme.space[5] },
  dock: { position: 'absolute', left: 0, bottom: 0, pointerEvents: 'box-none' },
  dockColumn: { width: '100%', maxWidth: COLUMN, minWidth: 0, alignSelf: 'center', pointerEvents: 'box-none' },
  // The page's ground behind the composer, hiding what scrolls under it; drawn first, so everything in the dock is above it.
  skirt: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: c.ground, pointerEvents: 'none' },
  skirtLow: { top: SKIRT_TOP },
  body: { ...theme.type.sub, color: c.text2 },
  warning: { ...theme.type.small, color: c.text2, paddingTop: theme.space[2] },
  noSales: { gap: theme.space[2], alignItems: 'flex-start' },
  questions: { gap: theme.space[3], paddingTop: theme.space[4] },
  latest: { position: 'absolute', right: 0, zIndex: 1, backgroundColor: c.ground },
  // Read by screen readers, not drawn.
  live: { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden' },
  error: { gap: theme.space[2], paddingTop: theme.space[2] },
  spent: {
    padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border, marginTop: theme.space[3],
  },
});
