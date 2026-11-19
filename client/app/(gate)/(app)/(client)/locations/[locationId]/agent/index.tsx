import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';

import { aboutDraft, orderDraft } from '../../../../../../../src/chat/about';
import { openToDecide, useAgentPanel, type SendToChat } from '../../../../../../../src/chat/useAgentPanel';
import { useTuningChat } from '../../../../../../../src/chat/useTuningChat';
import { AgentChat, landingShowsQuestions, type AgentChatContext, type AgentChatHandle } from '../../../../../../../src/chat/ui/AgentChat';
import { AgentSidePanel } from '../../../../../../../src/chat/ui/AgentSidePanel';
import { questionChatOf } from '../../../../../../../src/chat/ui/QuestionCard';
import { fetchEstimatesAbout } from '../../../../../../../src/portal/estimates/api';
import { fetchOrderBoard } from '../../../../../../../src/portal/orders/api';
import { useBreakpoint, useLoad } from '../../../../../../../src/portal/hooks';
import { localToday } from '../../../../../../../src/portal/locations/dates';
import { useOrgRefreshOnLeave } from '../../../../../../../src/portal/locations/parts';
import { usePortal, useReadOnly } from '../../../../../../../src/portal/PortalProvider';
import { useLocation } from '../../../../../../../src/portal/shell/LocationShell';
import { Hidden } from '../../../../../../../src/chat/ui/controls';
import { webAria } from '../../../../../../../src/portal/ui/aria';
import { Wrap } from '../../../../../../../src/portal/ui/layout';
import { theme } from '../../../../../../../src/theme';
import { allUploadsOff } from '../../../../../../../src/portal/locations/sales';
import { takeAsk } from '../../../../../../../src/portal/research/ask';

// P25 TownwiseAI (/locations/[locationId]/agent, members; spec 16.3, D26): the chat page and its panel, Questions
// and activity (Questions for you, What it's been doing, the budget, How TownwiseAI works), which shows only on the new
// chat page (spec P25 build note, 2026-11-18): AgentChat draws it as a column beside the landing from 641px, open by
// default, and as a row under the chips at 640px and below, collapsed by default. Whether it is open lives here, in
// memory: the person's choice, else the width's default. The landing lists the questions under its chips, so the
// panel leaves Questions for you out there (owner request, 2026-11-15). The page has no header of its own: the
// chat header is the first thing under the portal's top bar and the chat fills the rest of the screen, with a
// visually hidden h1, TownwiseAI, for screen readers.
// Under view-as (spec 15.5) everything reads, and every write control stays in place, disabled, described by the one
// read-only line. The logic is in src/chat; this file only lays it out.
// F7: `?about=YYYY-MM-DD` (from Analytics' day panel) fills an empty composer with "Tell me about Sat, Nov 21" and
// sends nothing; a date that isn't valid is ignored. F10: GET .../estimates/about says whether a forecast is published,
// for what TownwiseAI says it reads and How TownwiseAI works' forecast line. `?order=YYYY-MM-DD` (and `&item=`, from
// Orders) fills it with a question about that order, drafted only from the location's own live board (GET .../orders,
// never the sample); an order or item the board doesn't have fills nothing. `?panel=questions` (Home's "N questions
// from TownwiseAI") opens the panel on load, Questions for you first, and the address drops it. `?ask=found` (the
// Calendar's Ask TownwiseAI on a found event, D66) opens a new conversation with the draft the Calendar left in memory
// (src/portal/research/ask.ts), sending nothing, and the address drops it.
// A question's Something else… sends its message through the chat drawn here, and on web focus goes to the composer,
// as after a chip. The turn opens a conversation, so the panel goes with the landing; a turn refused outright leaves
// the landing and the panel, with the card's words and the reason in view.

const READ_ONLY_ID = 'chat-ro';

export default function TownwiseAIScreen(): React.JSX.Element {
  // The portal's client, so the access errors of spec 4.3 re-read GET /api/me and route again.
  const { api, me } = usePortal();
  const { location, org } = useLocation();
  const { readOnly, line } = useReadOnly();
  const { phone } = useBreakpoint();
  // A note saved from a card or an answer changes the location's notes count: the organization is read again on leaving.
  const markOrgStale = useOrgRefreshOnLeave();
  // Back within 5 minutes, the page opens the conversation it closed on, kept per person, location and view-as target.
  const chat = useTuningChat(api, location.id, { userId: me.user.id, readOnly, onNoteAdded: markOrgStale, viewAsId: me.viewAs?.target.userId ?? null });
  const panel = useAgentPanel(api, location.id, markOrgStale);
  const about = useLoad(useCallback(() => fetchEstimatesAbout(api, location.id), [api, location.id]));
  const params = useLocalSearchParams<{
    about?: string | string[]; order?: string | string[]; item?: string | string[]; panel?: string | string[]; ask?: string | string[];
  }>();
  const orderParam = Array.isArray(params.order) ? params.order[0] : params.order;
  const itemParam = Array.isArray(params.item) ? params.item[0] : params.item;
  const [orderText, setOrderText] = useState<string | null>(null);
  useEffect(() => {
    if (orderParam === undefined) return undefined;
    let live = true;
    // The location's own board only: the sample is never explained in chat, so a sample's link fills nothing.
    fetchOrderBoard(api, location.id).then(
      (board) => { if (live) setOrderText(orderDraft(orderParam, itemParam, board.available && !board.sample ? board : null)); },
      () => { if (live) setOrderText(null); },
    );
    return () => { live = false; };
  }, [api, itemParam, location.id, orderParam]);
  const draft = orderText ?? aboutDraft(params.about, localToday());
  const filled = useRef<string | null>(null);
  const { setDraft } = chat;
  const empty = chat.state.draft === '';
  useEffect(() => {
    // Once per address: what the person types afterwards, or a New chat, is theirs.
    if (draft === null || filled.current === draft) return;
    filled.current = draft;
    if (empty) setDraft(draft);
  }, [draft, empty, setDraft]);
  // Open by default beside the landing from 641px, collapsed under the chips at 640px and below, until the person chooses.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const panelOpen = chosen ?? !phone;
  // ?panel=questions opens the panel once per arrival; the person can close it, and the address drops it. At 640px and
  // below it opens with Questions for you first, until the person opens or closes the row.
  const askedPanel = params.panel === 'questions';
  const [openedFor, setOpenedFor] = useState(false);
  const [questionsFirst, setQuestionsFirst] = useState(false);
  if (askedPanel !== openedFor) {
    setOpenedFor(askedPanel);
    if (askedPanel) {
      setChosen(true);
      setQuestionsFirst(true);
    }
  }
  // This screen's own navigation: the router's setParams goes to the focused route, which isn't ready while the page mounts.
  const navigation = useNavigation<{ setParams: (params: { panel: undefined } | { ask: undefined }) => void }>();
  useEffect(() => {
    if (askedPanel) navigation.setParams({ panel: undefined });
  }, [askedPanel, navigation]);
  // Ask TownwiseAI on a found event: once the chat has loaded, a new conversation with the Calendar's draft.
  const askFound = params.ask === 'found';
  const chatReady = chat.state.status === 'ready';
  const { newConversation } = chat;
  // Once per arrival with `?ask=found`: a later Ask, with the page still mounted, is a new arrival.
  const askTaken = useRef(false);
  useEffect(() => {
    if (!askFound) {
      askTaken.current = false;
      return;
    }
    if (!chatReady || askTaken.current) return;
    askTaken.current = true;
    navigation.setParams({ ask: undefined });
    const text = takeAsk(location.id);
    if (text === null) return;
    newConversation();
    setDraft(text);
  }, [askFound, chatReady, location.id, navigation, newConversation, setDraft]);
  const chatView = useRef<AgentChatHandle>(null);
  // iOS: the keyboard avoider measures itself from its parent, so it is offset by the portal's top bar above it.
  const root = useRef<React.ComponentRef<typeof View>>(null);
  const [top, setTop] = useState(0);

  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const ctx: AgentChatContext = {
    town: location.town.name,
    locationId: location.id,
    locationName: location.name,
    orgName: org.org.name,
    hasSales: location.coverage.dayCount > 0,
    uploadsOff: allUploadsOff(location),
    hasTownProfile: location.town.townId !== null,
    hasForecast: about.state.status === 'ready' && about.state.data.forecast.run !== null,
    coverage: { dayCount: location.coverage.dayCount, lastDate: location.coverage.lastDate },
  };
  // The header's button counts what the panel asks the person to decide, as Home's link does.
  const questions = openToDecide(panel);
  const tellFromPanel: SendToChat = (message, ended) => {
    const view = chatView.current;
    if (view === null) {
      ended('TownwiseAI isn’t ready yet. Try again.');
      return;
    }
    view.tell(message, { ended }, true);
  };
  const sections = (
    <AgentSidePanel
      panel={panel}
      budget={chat.state.budget}
      ctx={ctx}
      locationId={location.id}
      locationName={location.name}
      readOnlyId={readOnlyId}
      chat={questionChatOf(chat.state)}
      send={tellFromPanel}
      about={about.state}
      onRetryAbout={about.reload}
      showQuestions={!landingShowsQuestions(chat.state, panel, phone)}
    />
  );

  return (
    <View
      ref={root}
      style={styles.fill}
      onLayout={() => { root.current?.measureInWindow((_x, y) => { setTop(y); }); }}
    >
      <View role="heading" accessible {...webAria({ 'aria-level': 1 })}><Hidden>TownwiseAI</Hidden></View>
      <KeyboardAvoidingView behavior="padding" enabled={Platform.OS === 'ios'} keyboardVerticalOffset={top} style={styles.fill}>
        <Wrap style={styles.wrap}>
          <AgentChat
            chat={chat}
            ctx={ctx}
            readOnlyId={readOnlyId}
            readOnlyLine={line}
            panelOpen={panelOpen}
            onTogglePanel={() => {
              setChosen(!panelOpen);
              setQuestionsFirst(false);
            }}
            openQuestions={questions}
            panelSections={sections}
            panel={panel}
            questionsFirst={questionsFirst}
            handleRef={chatView}
          />
        </Wrap>
      </KeyboardAvoidingView>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: c.ground },
  wrap: { flex: 1, minHeight: 0, paddingTop: theme.space[4], paddingBottom: theme.space[4] },
});
