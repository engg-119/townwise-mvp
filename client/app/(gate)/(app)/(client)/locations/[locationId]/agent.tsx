import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useNavigation } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { aboutDraft, orderDraft } from '../../../../../../src/chat/about';
import { openQuestions, useAgentPanel, type SendToChat } from '../../../../../../src/chat/useAgentPanel';
import { useTuningChat } from '../../../../../../src/chat/useTuningChat';
import { AgentChat, landingShowsQuestions, type AgentChatContext, type AgentChatHandle } from '../../../../../../src/chat/ui/AgentChat';
import { AgentSidePanel } from '../../../../../../src/chat/ui/AgentSidePanel';
import { PanelSheet } from '../../../../../../src/chat/ui/PanelSheet';
import { questionChatOf } from '../../../../../../src/chat/ui/QuestionCard';
import { fetchEstimatesAbout } from '../../../../../../src/portal/estimates/api';
import { fetchOrderBoard } from '../../../../../../src/portal/orders/api';
import { useBreakpoint, useLoad } from '../../../../../../src/portal/hooks';
import { localToday } from '../../../../../../src/portal/locations/dates';
import { useOrgRefreshOnLeave } from '../../../../../../src/portal/locations/parts';
import { usePortal, useReadOnly } from '../../../../../../src/portal/PortalProvider';
import { useLocation } from '../../../../../../src/portal/shell/LocationShell';
import { Hidden } from '../../../../../../src/chat/ui/controls';
import { webAria } from '../../../../../../src/portal/ui/aria';
import { Wrap } from '../../../../../../src/portal/ui/layout';
import { theme } from '../../../../../../src/theme';
import { allUploadsOff } from '../../../../../../src/portal/locations/sales';

// P25 TownwiseAI (/locations/[locationId]/agent, members; spec 16.3, D26): the chat page and its panel, Questions
// and activity (Questions for you, What it's been doing, the budget, How TownwiseAI works). The panel is closed by
// default and its open state lives here, in memory. Open from 1024px, the chat takes columns 1 to 8 and the panel 9 to
// 12, scrolling on its own; closed, the chat takes 1 to 12. Beside an empty conversation's landing, which lists the
// questions under its chips, the column leaves Questions for you out (owner request, 2026-11-15); the sheet, drawn over
// the landing, keeps them. Below 1024px the panel is a full-screen sheet. The chat
// is drawn in the same place either way, so opening the panel never redraws it. The page has no header of its own: the
// chat header is the first thing under the portal's top bar and the chat fills the rest of the screen, with a
// visually hidden h1, TownwiseAI, for screen readers.
// Under view-as (spec 15.5) everything reads, and every write control stays in place, disabled, described by the one
// read-only line. The logic is in src/chat; this file only lays it out.
// F7: `?about=YYYY-MM-DD` (from Analytics' day panel) fills an empty composer with "Tell me about Sat, Nov 21" and
// sends nothing; a date that isn't valid is ignored. F10: GET .../estimates/about says whether a forecast is published,
// for what TownwiseAI says it reads and How TownwiseAI works' forecast line. `?order=YYYY-MM-DD` (and `&item=`, from
// Orders) fills it with a question about that order, drafted only from the location's own live board (GET .../orders,
// never the sample); an order or item the board doesn't have fills nothing. `?panel=questions` (Home's "N questions
// from TownwiseAI") opens the panel on load, Questions for you first, and the address drops it.
// A question's Something else… sends its message through the chat drawn here. From the column the panel stays open;
// from the sheet the sheet closes once the turn starts (its first event), so the thread shows the message and the
// reply, and on web focus goes to the composer, as after a chip. A turn refused outright leaves the sheet open, with
// the card's words and the reason in view.

const READ_ONLY_ID = 'chat-ro';

type Host = React.ComponentRef<typeof View>;

export default function TownwiseAIScreen(): React.JSX.Element {
  // The portal's client, so the access errors of spec 4.3 re-read GET /api/me and route again.
  const { api, me } = usePortal();
  const { location, org } = useLocation();
  const { readOnly, line } = useReadOnly();
  const { desktop } = useBreakpoint();
  // A note saved from a card or an answer changes the location's notes count: the organization is read again on leaving.
  const markOrgStale = useOrgRefreshOnLeave();
  const chat = useTuningChat(api, location.id, { userId: me.user.id, readOnly, onNoteAdded: markOrgStale });
  const panel = useAgentPanel(api, location.id, markOrgStale);
  const about = useLoad(useCallback(() => fetchEstimatesAbout(api, location.id), [api, location.id]));
  const params = useLocalSearchParams<{
    about?: string | string[]; order?: string | string[]; item?: string | string[]; panel?: string | string[];
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
  const [panelOpen, setPanelOpen] = useState(false);
  // ?panel=questions opens the panel once per arrival; the person can close it, and the address drops it.
  const askedPanel = params.panel === 'questions';
  const [openedFor, setOpenedFor] = useState(false);
  if (askedPanel !== openedFor) {
    setOpenedFor(askedPanel);
    if (askedPanel) setPanelOpen(true);
  }
  // This screen's own navigation: the router's setParams goes to the focused route, which isn't ready while the page mounts.
  const navigation = useNavigation<{ setParams: (params: { panel: undefined }) => void }>();
  useEffect(() => {
    if (askedPanel) navigation.setParams({ panel: undefined });
  }, [askedPanel, navigation]);
  const panelButton = useRef<Host>(null);
  const closePanel = useCallback(() => { setPanelOpen(false); }, []);
  const chatView = useRef<AgentChatHandle>(null);
  // A question's message closed the sheet: focus goes to the composer, not back to the panel button (web).
  const toComposer = useRef(false);
  const restoreFocus = useCallback(() => {
    if (toComposer.current) chatView.current?.focusComposer();
    else panelButton.current?.focus();
    toComposer.current = false;
  }, []);
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
  const questions = openQuestions(panel);
  const tellFromPanel: SendToChat = (message, ended) => {
    const view = chatView.current;
    if (view === null) {
      ended('TownwiseAI isn’t ready yet. Try again.');
      return;
    }
    const started = (): void => {
      if (desktop) return;
      toComposer.current = true;
      setPanelOpen(false);
    };
    view.tell(message, { started, ended }, desktop);
  };
  const column = desktop && panelOpen;
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
      showQuestions={!(column && landingShowsQuestions(chat.state, panel))}
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
          <View style={styles.grid}>
            <View style={column ? styles.main : styles.fill}>
              <AgentChat
                chat={chat}
                ctx={ctx}
                readOnlyId={readOnlyId}
                readOnlyLine={line}
                panelOpen={panelOpen}
                onTogglePanel={() => {
                  // A turn that started after the person shut the sheet themselves leaves no say over the next close.
                  toComposer.current = false;
                  setPanelOpen((open) => !open);
                }}
                openQuestions={questions}
                panelButtonRef={panelButton}
                panel={panel}
                handleRef={chatView}
              />
            </View>
            {column ? (
              <View style={styles.side}>
                <ScrollView style={styles.fill} contentContainerStyle={styles.sideContent} testID="agent-side">{sections}</ScrollView>
              </View>
            ) : null}
          </View>
        </Wrap>
      </KeyboardAvoidingView>
      <PanelSheet open={panelOpen} onClose={closePanel} openerRef={panelButton} restoreFocus={restoreFocus}>
        <View testID="agent-side">{sections}</View>
      </PanelSheet>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, minWidth: 0, backgroundColor: c.ground },
  wrap: { flex: 1, minHeight: 0, paddingTop: theme.space[4], paddingBottom: theme.space[4] },
  grid: { flex: 1, minHeight: 0, flexDirection: 'row', columnGap: theme.space.gutter },
  main: { flex: 8, minWidth: 0, minHeight: 0 },
  side: { flex: 4, minWidth: 0, minHeight: 0 },
  sideContent: { gap: theme.space[8], paddingBottom: theme.space[8] },
});
