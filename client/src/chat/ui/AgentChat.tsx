import { Fragment, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, Platform, ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle,
} from 'react-native';

import { useReducedMotion } from '../../motion';
import { useBreakpoint } from '../../portal/hooks';
import { localToday } from '../../portal/locations/dates';
import { useOptionalPortal } from '../../portal/PortalProvider';
import { locationHref } from '../../portal/routing';
import { Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice, Messages, ReadOnlyLine } from '../../portal/ui/feedback';
import { Skeleton, SkeletonButton, SkeletonHeading, SkeletonText, SkeletonWords } from '../../portal/skeleton/kit';
import { Heading } from '../../portal/ui/text';
import { theme } from '../../theme';
import { formatCount } from '../format';
import { watchScrollIntent, type ScrollIntent } from '../scrollIntent';
import { usePageVisible } from '../visible';
import { INITIAL_PIN, nextPin, type PinEvent, type PinState } from '../scrollPin';
import { nextFallback, suggestionsFor } from '../suggestions';
import { readsLine, toolLine, type ToolContext } from '../tools';
import { openQuestions, type AgentPanelState } from '../useAgentPanel';
import type { MessageAttachment } from '../api';
import { canSend, messageText, stepsOf, type ChatMessage, type Telling, type TuningChat, type TuningChatState } from '../useTuningChat';
import { budgetLines } from './AgentSidePanel';
import { ChatDrop } from './ChatDrop';
import { ChatHeader, ChatHeaderSkeleton, PANEL_ID, PanelButton } from './ChatHeader';
import { Composer, ComposerSkeleton, type ComposerHandle } from './Composer';
import { useComposerFiles } from './ComposerFiles';
import { focusLost } from './controls';
import { NextChips } from './NextChips';
import { PanelRow, PanelRowSkeleton } from './PanelRow';
import { PreviousChats } from './PreviousChats';
import { QuestionCard, questionChatOf, QuestionsNoticeLine } from './QuestionCard';
import { ReplyView } from './ReplyView';
import { Suggestions, SuggestionsSkeleton } from './Suggestions';
import { FadeIn } from './ToolGroup';
import { UserMessage } from './UserMessage';
import { workedOpenStore } from './workedOpen';

// The TownwiseAI chat page (spec P25, D26): the header (History,
// New chat and, on the new chat page, Questions and activity; no title), then the landing of an empty conversation (one column, centered across and starting at the top: what to ask,
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
// Previous chats (spec P25 build note, 2026-11-18): while there is any earlier chat, the landing has a Previous chats
// dropdown under its chips (PreviousChats), closed at first; the list is read every 3 seconds while a chat replies and
// the page is in view.
//
// The landing starts at the top (spec P25 build note, 2026-11-18): an independent browser review saw a centered
// landing jump when TownwiseAI's questions came under its chips (176px at 1280px) and the centered skeleton give way
// to a landing with questions 101px higher at 390px. At the top, it is in one place in every state and load order.
// [CONFIRM: the TownwiseAI new chat page starts at the top rather than centred, so it never moves while it loads]
//
// Questions and activity (spec P25 build note, 2026-11-18; owner: "we should likely put the questions and activity back
// to the right side of the screen and it should only appear on the new chat page", then "the questions below should be
// moved to the right side": from 641px TownwiseAI's questions are in the column, not under the chips): shown only while no conversation is
// open (the landing, and the skeleton, the error and TownwiseAI off, where the panel still works). From 641px it is a
// column (4 of 12) beside the landing, under the header, open by default and shown or hidden by the header's button; at
// 640px and below it is PanelRow under the chips, collapsed by default and opening in place. Inside a conversation
// neither the panel nor its button shows. The column is drawn beside the same main box whether or not it shows, so
// showing it never draws the landing again.
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

/** What the page does through the chat for the panel's question cards. */
export interface AgentChatHandle {
  /**
   * Sends a question's Something else… message in the conversation shown (the landing starts one), as a chip does
   * (TuningChat.tell). `focus`: on web focus goes to the composer at once.
   */
  tell: (message: string, telling: Telling, focus: boolean) => void;
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

/** The notice over the composer while a send waits on the person's turn running in another chat. */
export function stillReplying(title: string): string {
  return `TownwiseAI is still replying in “${title}”.`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The docked composer's last rotating example, once there are sales to tell about. */
const SATURDAY = 'Tell me about last Saturday';

/**
 * What the landing says TownwiseAI saves (UI review 2026-11-19): while it works on its own (D59, the panel's
 * `agentAuto` on and running here) what it's sure of, with Undo; otherwise, as before, notes the person decides on.
 */
const SAVES_AUTO = 'It saves what it’s sure of, each change with Undo in its activity; anything it isn’t sure of waits for you.';
const SAVES_OFF = 'It suggests notes; you decide what’s saved.';

/** TownwiseAI works on its own here, from the panel's read: off while it loads, fails or comes from an API before D59. */
function worksOnItsOwn(panel: AgentPanelState): boolean {
  const auto = panel.state.status === 'ready' ? panel.state.data.agentAuto : null;
  return auto?.on === true && auto.available;
}

/**
 * The landing's words (spec P25), known from the location before the chat loads: the landing and its skeleton both
 * set them, so the skeleton takes the lines the landing will. `auto`: TownwiseAI works on its own here.
 */
function landingWords(ctx: AgentChatContext, auto: boolean): { heading: string; line: string; help: string; link: boolean } {
  return {
    heading: `Ask TownwiseAI about ${ctx.locationName}`,
    line: ctx.hasSales
      ? `It reads ${readsLine(ctx)}, and shows you each thing it reads. ${auto ? SAVES_AUTO : SAVES_OFF}`
      : ctx.uploadsOff === true
        ? `Every sales upload for this location is turned off, so TownwiseAI can only use ${readsLine(ctx, { sales: false })}. Turn one back on in Your data.`
        : `You haven’t uploaded sales yet, so TownwiseAI can only use ${readsLine(ctx, { sales: false })}.`,
    help: `Leave out guest names. TownwiseAI answers from ${readsLine(ctx)}.`,
    // Without sales, Open Your data or (on web) Upload sales under the line.
    link: !ctx.hasSales && (ctx.uploadsOff === true || Platform.OS === 'web'),
  };
}

/** The landing's quick-start chips, from the location and today. */
function landingSuggestions(ctx: AgentChatContext, today: string): ReturnType<typeof suggestionsFor> {
  return suggestionsFor({ coverage: ctx.coverage, today, townName: ctx.town, hasTownProfile: ctx.hasTownProfile });
}

/**
 * The page while TownwiseAI loads (spec P25, owner, 2026-11-18: "fix the skeleton loader on townwise ai so there is one
 * because it just says loading townwise ai"): the header's controls, then the landing's heading, line, composer and
 * chips, in the header's and the landing's own rows, column and split (Split), starting at the top as the landing does. The landing's
 * own words (`landingWords`, the chips' labels) are set in its own type and drawn as bars, and the composer and chips are
 * their own shapes, so each row takes the lines the landing's will at any width and the landing replaces it without
 * moving (an independent browser review saw it move 48px at 1280px and 64px at 390px when the skeleton guessed its
 * lines). "Loading TownwiseAI…" stays its one status line for screen readers. TownwiseAI's questions under the chips
 * load with the side panel, on their own. The panel's places are the landing's (build note, 2026-11-18): from 641px the
 * header has its three icons and, while the panel is open, a column of shapes stands where the panel's column will;
 * at 640px and below the header has two and the collapsed Questions and activity row stands under the chips. A turn still running opens its conversation as the page loads
 * (useTuningChat), so a refresh mid-reply goes from this to the thread, never through the landing. Nothing here
 * scrolls, so the thread's pin starts fresh when the thread mounts.
 */
function PageSkeleton(props: { ctx: AgentChatContext; phone: boolean; beside: boolean; auto: boolean }): React.JSX.Element {
  const words = landingWords(props.ctx, props.auto);
  const line = <Text style={styles.body}><SkeletonWords>{words.line}</SkeletonWords></Text>;
  return (
    <Skeleton name="agent" label="Loading TownwiseAI…" fill>
      <View style={styles.fill}>
        <ChatHeaderSkeleton panel={!props.phone} />
        <Split
          side={props.beside ? (
            <View testID="skeleton-agent-side" style={[styles.side, styles.sideContent]}>
              <SkeletonHeading width={160} />
              <SkeletonText lines={3} type="small" />
            </View>
          ) : null}
        >
          {/* The landing's ScrollView and its content box, as boxes that don't scroll. */}
          <View style={styles.fill}>
            <View style={styles.landingScroll}>
              <View testID="skeleton-agent-landing" style={styles.landing}>
                <Heading><SkeletonWords>{words.heading}</SkeletonWords></Heading>
                {props.ctx.hasSales ? line : (
                  <View style={styles.noSales}>
                    {line}
                    {words.link ? <SkeletonButton link width={120} /> : null}
                  </View>
                )}
                <View testID="skeleton-agent-composer">
                  <ComposerSkeleton help={words.help} />
                </View>
                <SuggestionsSkeleton items={landingSuggestions(props.ctx, localToday())} />
                {props.phone ? <PanelRowSkeleton /> : null}
              </View>
            </View>
          </View>
        </Split>
      </View>
    </Skeleton>
  );
}

/**
 * What is under the header, with the panel's column (`side`) beside it from 641px, 8 and 4 of 12: the page and its
 * skeleton both draw it, so the landing and its skeleton take the same width and place (an independent browser review,
 * 2026-11-18, saw the skeleton's landing 224px wide at 1280px where the landing is 745px). The main box is the same
 * whether or not the column shows, so showing it never draws the landing again.
 */
function Split(props: { children: React.ReactNode; side: React.JSX.Element | null }): React.JSX.Element {
  return (
    <View style={styles.split}>
      <View style={props.side === null ? styles.fill : styles.main}>{props.children}</View>
      {props.side}
    </View>
  );
}

/** An empty conversation, drawn as the landing: what to ask, the composer, the chips and TownwiseAI's questions. */
function isLanding(state: TuningChatState): boolean {
  return state.status === 'ready' && state.enabled && state.messages.length === 0 && !state.conversationLoading;
}

/**
 * Whether the landing lists TownwiseAI's questions under its chips (at 640px and below only), so the panel leaves them
 * out; from 641px they are in the column beside the landing (owner, 2026-11-18).
 */
export function landingShowsQuestions(state: TuningChatState, panel: AgentPanelState, phone: boolean): boolean {
  return phone && isLanding(state) && panel.state.status === 'ready' && panel.state.data.questions.length > 0;
}

export function AgentChat(props: {
  chat: TuningChat;
  ctx: AgentChatContext;
  readOnlyId: string | null;
  readOnlyLine: string;
  /** Questions and activity is open: the column beside the new chat page from 641px, the row's region at 640px and below. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** The open questions, for the panel button and row; null while they load. */
  openQuestions: number | null;
  /** The panel's sections (AgentSidePanel), drawn in the column or under the row. */
  panelSections: React.ReactNode;
  /** TownwiseAI's questions, also shown on the landing under the chips. */
  panel: AgentPanelState;
  /**
   * The panel was opened by `?panel=questions` (Home's link) and the person hasn't opened or closed it since: at 640px
   * and below the opened row shows the landing's questions first, above the panel's sections, so they are in view.
   */
  questionsFirst?: boolean;
  handleRef?: React.Ref<AgentChatHandle>;
}): React.JSX.Element {
  const { chat, ctx } = props;
  const { state } = chat;
  const reduced = useReducedMotion();
  const { phone } = useBreakpoint();
  const scroll = useRef<Scroller>(null);
  const composer = useRef<ComposerHandle>(null);
  // The composer's + and the page's drop (web, stored files on): the files on the message, and the lines about them.
  const files = useComposerFiles(ctx.locationId, props.readOnlyId, () => { composer.current?.focus(); });
  const toldFiles = useRef(new Set<string>());
  // The pin lives in a ref (every scroll event moves it); only whether Latest shows is drawn.
  const pin = useRef<PinState>(INITIAL_PIN);
  const [behind, setBehind] = useState(false);
  // Whether the person is scrolling the thread, which alone can unpin it (scrollPin.ts): on web the input heard on
  // its scrolling element (scrollIntent.ts); on native a drag, and the momentum it leaves.
  const intent = useRef<ScrollIntent | null>(null);
  const touching = useRef({ drag: false, momentum: false });
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

  // The list is watched (read every 3 seconds while a conversation replies, useTuningChat) while History is open, and
  // while the new chat page is in view, for its Previous chats.
  const [historyOpen, setHistoryOpen] = useState(false);
  const visible = usePageVisible();
  const { watchList } = chat;
  const watching = historyOpen || (landing && visible);
  useEffect(() => { watchList(watching); }, [watchList, watching]);

  // The conversation whose reply streams here is replying, whatever the list last read said.
  const listed = state.conversations.map((item) => (state.streaming && item.id === state.conversationId && !item.running ? { ...item, running: true } : item));
  // Previous chats shows while there is any earlier chat, and stays while it is open, so a row holding focus is never
  // unmounted from under the person; closed with no chat left, it goes (and focus, if it was on the toggle, goes to the composer).
  const [previousOpen, setPreviousOpen] = useState(false);
  const previousShown = listed.length > 0 || previousOpen;
  const wasShown = useRef(false);
  if (!landing && previousOpen) setPreviousOpen(false);
  useEffect(() => {
    const gone = wasShown.current && !previousShown;
    wasShown.current = previousShown;
    if (gone && landing && Platform.OS === 'web' && focusLost()) composer.current?.focus();
  }, [previousShown, landing]);

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
  // the end, then moved.) `heard` is the latest render's, read when the observer fires. The person's scrolling is heard
  // on the same element.
  const thread = state.status === 'ready' && state.enabled && !landing;
  const heard = useRef<(height: number) => void>(() => undefined);
  useLayoutEffect(() => {
    heard.current = (height) => {
      measureBar();
      apply({ type: 'contentGrew', contentHeight: height - dockWas.current });
    };
  });
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !thread) return undefined;
    const node = scroll.current?.getScrollableNode() as unknown as HTMLElement | null | undefined;
    if (node == null) return undefined;
    const watching = watchScrollIntent(node);
    intent.current = watching;
    const content = node.firstElementChild as HTMLElement | null;
    const observer = content === null || typeof ResizeObserver !== 'function' ? null : new ResizeObserver(() => { heard.current(content.offsetHeight); });
    if (content !== null) observer?.observe(content);
    return () => {
      observer?.disconnect();
      watching.stop();
      intent.current = null;
    };
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

  useImperativeHandle(props.handleRef, () => ({ tell }));

  /** The person opens conversation `to` (null: a new one): the composer's files stay with the one shown, as its draft does. */
  function opened(run: () => void, to: string | null): void {
    // Opening the conversation whose reply streams changes nothing (useTuningChat), so its files stay too.
    if (!(state.streaming && to === state.conversationId)) files.switchTo(state.conversationId, to);
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
  // From 641px the panel's column shows beside what is under the header while no conversation is open.
  const beside = !phone && props.panelOpen;
  /** `main` under the header, with the panel's column beside it when `column`. */
  function split(main: React.ReactNode, column: boolean): React.JSX.Element {
    return (
      <Split
        side={column ? (
          <ScrollView nativeID={PANEL_ID} testID="agent-side" style={styles.side} contentContainerStyle={styles.sideContent}>
            {props.panelSections}
          </ScrollView>
        ) : null}
      >
        {main}
      </Split>
    );
  }
  /** The row at 640px and below, opening to `lead` (the landing's questions, or nothing) and the panel's sections. */
  function panelRow(lead: React.ReactNode = null): React.JSX.Element {
    return (
      <PanelRow open={props.panelOpen} openQuestions={props.openQuestions} onPress={props.onTogglePanel}>{lead}{props.panelSections}</PanelRow>
    );
  }
  // TownwiseAI off or unreadable still has its panel: the questions and activity don't need the chat (spec 10.12).
  function panelOnly(content: React.ReactNode): React.JSX.Element {
    return (
      <View style={styles.fill}>
        {phone ? null : (
          <View style={styles.panelBar}>
            <PanelButton open={props.panelOpen} openQuestions={props.openQuestions} onPress={props.onTogglePanel} />
          </View>
        )}
        {split(<>{phone ? panelRow() : null}{content}</>, beside)}
        {drop}
      </View>
    );
  }

  // Every state of the page catches a drop of files, so the browser never opens one in its place.
  if (state.status === 'loading') return <View style={styles.fill}><PageSkeleton ctx={ctx} phone={phone} beside={beside} auto={worksOnItsOwn(props.panel)} />{drop}</View>;
  if (state.status === 'not_found') return <View style={styles.fill}><Text style={styles.body}>This location wasn’t found.</Text>{drop}</View>;
  if (state.status === 'failed') return panelOnly(<ErrorNotice message={state.loadError ?? 'Something went wrong.'} onRetry={chat.reload} />);
  if (!state.enabled) {
    return panelOnly(
      <>
        <Text style={styles.body}>TownwiseAI isn’t turned on yet.</Text>
        {readOnlyLine}
      </>,
    );
  }

  const today = localToday();
  const suggestions = landingSuggestions(ctx, today);
  const words = landingWords(ctx, worksOnItsOwn(props.panel));
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
      conversations={listed}
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
      panel={landing && !phone}
      onListOpen={setHistoryOpen}
    />
  );
  
  // A send refused because the person's one running turn is in another chat (useTuningChat): standing state, not an
  // error (D55), with a link that opens that chat. The text stays in the composer for when that turn ends.
  const elsewhere = state.runningElsewhere === null ? null : state.conversations.find((item) => item.id === state.runningElsewhere) ?? null;
  // What sits right above the composer, wherever it is.
  const notices = (
    <>
      {warning === null ? null : <Text style={styles.warning}>{warning}</Text>}
      {elsewhere === null ? null : (
        <View testID="chat-running-elsewhere" style={styles.error}>
          <Messages live="status" items={[stillReplying(elsewhere.title)]} />
          <Button variant="link" label="Open that chat" onPress={() => { opened(() => { chat.openConversation(elsewhere.id); }, elsewhere.id); }} />
        </View>
      )}
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
  const noticed = warning !== null || elsewhere !== null || files.alerts.length > 0 || state.error !== null || props.readOnlyLine !== '';

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
        help={words.help}
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

  // The panel's questions, under the chips: none while they load, when they can't be read, or when there are none (unless
  // a private event's notice says why its card went).
  const asked = props.panel.state.status === 'ready' ? props.panel.state.data.questions : [];
  const open = openQuestions(props.panel);
  const questionChat = questionChatOf(state);
  const last = state.messages.length - 1;
  // Home's link at 640px and below: the questions first in the opened row (an independent browser review, 2026-11-18,
  // found them under the whole panel, off screen at 390px). Otherwise they sit under the row.
  const questionsInRow = phone && props.panelOpen && props.questionsFirst === true;
  // A private event's notice (D71) stays with the heading when its card was the last.
  const questions = asked.length === 0 && props.panel.questionsNotice === null ? null : (
    <View testID="chat-landing-questions" style={questionsInRow ? styles.questionsInRow : styles.questions}>
      <Heading>{`Questions for you${open !== null && open > 0 ? ` (${formatCount(open)})` : ''}`}</Heading>
      <QuestionsNoticeLine panel={props.panel} place="landing" />
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
  );
  const body = landing ? (
    <ScrollView testID="chat-landing" style={styles.fill} contentContainerStyle={styles.landingScroll} keyboardShouldPersistTaps="handled">
      <View testID="chat-landing-column" style={styles.landing}>
        <Heading>{words.heading}</Heading>
        {ctx.hasSales ? <Text style={styles.body}>{words.line}</Text> : (
          <View style={styles.noSales}>
            <Text style={styles.body}>{words.line}</Text>
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
        {previousShown ? (
          <PreviousChats conversations={listed} open={previousOpen} onToggle={setPreviousOpen} onOpen={(id) => { opened(() => { chat.openConversation(id); }, id); }} />
        ) : null}
        {phone ? panelRow(questionsInRow ? questions : null) : null}
        {phone && !questionsInRow ? questions : null}
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
          const person = Platform.OS === 'web' ? intent.current?.person() === true : touching.current.drag || touching.current.momentum;
          apply({ type: 'scroll', y, contentHeight: contentSize.height - dock, viewportHeight: layoutMeasurement.height, person });
        }}
        // Native's own word for the person scrolling: a drag, then the momentum it leaves (react-native-web sends none).
        onScrollBeginDrag={() => { touching.current.drag = true; }}
        onScrollEndDrag={() => { touching.current.drag = false; }}
        onMomentumScrollBegin={() => { touching.current.momentum = true; }}
        onMomentumScrollEnd={() => { touching.current.momentum = false; }}
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
      {split(body, landing && beside)}
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
  split: { flex: 1, minHeight: 0, flexDirection: 'row', columnGap: theme.space.gutter },
  // The landing and the panel's column, 8 and 4 of 12; the column scrolls on its own.
  main: { flex: 8, minWidth: 0, minHeight: 0 },
  // Longhands: a ScrollView's own flexGrow would win over `flex`'s.
  side: { flexGrow: 4, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0 },
  sideContent: { gap: theme.space[8], paddingBottom: theme.space[8] },
  panelBar: {
    flexDirection: 'row', justifyContent: 'flex-end', borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border,
    paddingBottom: theme.space[2], marginBottom: theme.space[4],
  },
  landingScroll: { flexGrow: 1 },
  landing: {
    flexGrow: 1, justifyContent: 'flex-start', width: '100%', maxWidth: COLUMN, minWidth: 0, alignSelf: 'center', gap: theme.space[4],
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
  // First in the opened row, whose region has its own top padding: the panel's gap between sections under it.
  questionsInRow: { gap: theme.space[3], paddingBottom: theme.space[8] },
  latest: { position: 'absolute', right: 0, zIndex: 1, backgroundColor: c.ground },
  // Read by screen readers, not drawn.
  live: { position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden' },
  error: { gap: theme.space[2], paddingTop: theme.space[2] },
  spent: {
    padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border, marginTop: theme.space[3],
  },
});
