import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { aboutDraft, orderDraft } from '../../../../../../src/chat/about';
import { useAgentPanel } from '../../../../../../src/chat/useAgentPanel';
import { useTuningChat } from '../../../../../../src/chat/useTuningChat';
import { AgentChat, type AgentChatContext } from '../../../../../../src/chat/ui/AgentChat';
import { AgentSidePanel } from '../../../../../../src/chat/ui/AgentSidePanel';
import { PanelSheet } from '../../../../../../src/chat/ui/PanelSheet';
import { fetchEstimatesAbout } from '../../../../../../src/portal/estimates/api';
import { fetchOrderBoard } from '../../../../../../src/portal/orders/api';
import { useBreakpoint, useLoad } from '../../../../../../src/portal/hooks';
import { localToday } from '../../../../../../src/portal/locations/dates';
import { useOrgRefreshOnLeave } from '../../../../../../src/portal/locations/parts';
import { usePortal, useReadOnly } from '../../../../../../src/portal/PortalProvider';
import { useLocation, useScrollingHead } from '../../../../../../src/portal/shell/LocationShell';
import { Wrap } from '../../../../../../src/portal/ui/layout';
import { theme } from '../../../../../../src/theme';
import { allUploadsOff } from '../../../../../../src/portal/locations/sales';

// P25 TownwiseAI (/locations/[locationId]/agent, members; spec 16.3, D26): the chat page and its panel, Questions
// and activity (Questions for you, What it's been doing, the budget, How TownwiseAI works). The panel is closed by
// default and its open state lives here, in memory. Open from 1024px, the chat takes columns 1 to 8 and the panel 9 to
// 12, scrolling on its own; closed, the chat takes 1 to 12. Below 1024px the panel is a full-screen sheet. The chat
// is drawn in the same place either way, so opening the panel never redraws it. On phones the location's compact
// header sits at the top of what scrolls, so the conversation gets the screen.
// Under view-as (spec 15.5) everything reads, and every write control stays in place, disabled, described by the one
// read-only line. The logic is in src/chat; this file only lays it out.
// F7: `?about=YYYY-MM-DD` (from Analytics' day panel) fills an empty composer with "Tell me about Sat, Nov 21" and
// sends nothing; a date that isn't valid is ignored. F10: GET .../estimates/about says whether a forecast is published,
// for what TownwiseAI says it reads and How TownwiseAI works' forecast line. `?order=YYYY-MM-DD` (and `&item=`, from
// Orders) fills it with a question about that order, drafted only from the location's own live board (GET .../orders,
// never the sample); an order or item the board doesn't have fills nothing.

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
  const head = useScrollingHead();
  const about = useLoad(useCallback(() => fetchEstimatesAbout(api, location.id), [api, location.id]));
  const params = useLocalSearchParams<{ about?: string | string[]; order?: string | string[]; item?: string | string[] }>();
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
  const panelButton = useRef<Host>(null);
  const closePanel = useCallback(() => { setPanelOpen(false); }, []);
  // iOS: the keyboard avoider measures itself from its parent, so it is offset by the header above it.
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
  const questions = panel.state.status === 'ready'
    ? panel.state.data.questions.filter((question) => panel.answered[question.id] === undefined).length
    : null;
  const sections = (
    <AgentSidePanel
      panel={panel}
      budget={chat.state.budget}
      ctx={ctx}
      locationId={location.id}
      locationName={location.name}
      readOnlyId={readOnlyId}
      about={about.state}
      onRetryAbout={about.reload}
    />
  );
  const column = desktop && panelOpen;

  return (
    <View
      ref={root}
      style={styles.fill}
      onLayout={() => { root.current?.measureInWindow((_x, y) => { setTop(y); }); }}
    >
      <KeyboardAvoidingView behavior="padding" enabled={Platform.OS === 'ios'} keyboardVerticalOffset={top} style={styles.fill}>
        <Wrap style={styles.wrap}>
          <View style={styles.grid}>
            <View style={column ? styles.main : styles.fill}>
              <AgentChat
                chat={chat}
                ctx={ctx}
                top={head}
                readOnlyId={readOnlyId}
                readOnlyLine={line}
                panelOpen={panelOpen}
                onTogglePanel={() => { setPanelOpen((open) => !open); }}
                openQuestions={questions}
                panelButtonRef={panelButton}
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
      <PanelSheet open={panelOpen} onClose={closePanel} openerRef={panelButton}>
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
