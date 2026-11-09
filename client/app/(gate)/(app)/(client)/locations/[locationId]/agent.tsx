import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { aboutDraft } from '../../../../../../src/chat/about';
import { useAgentPanel } from '../../../../../../src/chat/useAgentPanel';
import { useTuningChat } from '../../../../../../src/chat/useTuningChat';
import { AgentChat, type AgentChatContext } from '../../../../../../src/chat/ui/AgentChat';
import { ActivitySection, AgentSidePanel, BudgetSection, HowItWorks, QuestionsSection } from '../../../../../../src/chat/ui/AgentSidePanel';
import { fetchEstimatesAbout } from '../../../../../../src/portal/estimates/api';
import { useBreakpoint, useLoad } from '../../../../../../src/portal/hooks';
import { localToday } from '../../../../../../src/portal/locations/dates';
import { useOrgRefreshOnLeave } from '../../../../../../src/portal/locations/parts';
import { usePortal, useReadOnly } from '../../../../../../src/portal/PortalProvider';
import { useLocation, useScrollingHead } from '../../../../../../src/portal/shell/LocationShell';
import { webAria } from '../../../../../../src/portal/ui/aria';
import { Wrap } from '../../../../../../src/portal/ui/layout';
import { theme } from '../../../../../../src/theme';

// P25 TownwiseAI (/locations/[locationId]/agent, members; spec 16.3): the chatbox and its side panel.
// From 1024px the chat takes columns 1 to 8 and fills the screen, and the side panel (Questions for you, What it's
// been doing, the budget, How TownwiseAI works) takes 9 to 12 and scrolls on its own. Below that, one column under a
// three-way switch, Chat, Questions and Activity; the chat keeps its state while another view shows. On phones the
// location's compact header and the switch sit at the top of what scrolls, so the conversation gets the screen.
// Under view-as (spec 15.5) everything reads, and every write control stays in place, disabled, described by the one
// read-only line. The logic is in src/chat; this file only lays it out.
// F7: `?about=YYYY-MM-DD` (from Analytics' day panel) fills an empty composer with "Tell me about Sat, Nov 21" and
// sends nothing; a date that isn't valid is ignored. F10: GET .../estimates/about says whether a forecast is published,
// for what TownwiseAI says it reads and How TownwiseAI works' forecast line.

const READ_ONLY_ID = 'chat-ro';

type View3 = 'chat' | 'questions' | 'activity';

function Switch(props: { value: View3; onChange: (value: View3) => void; questions: number | null }): React.JSX.Element {
  const options: { value: View3; label: string }[] = [
    { value: 'chat', label: 'Chat' },
    { value: 'questions', label: props.questions === null ? 'Questions' : `Questions (${String(props.questions)})` },
    { value: 'activity', label: 'Activity' },
  ];
  return (
    <View role="group" aria-label="TownwiseAI views" style={styles.switch}>
      {options.map((option) => {
        const on = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            role="button"
            accessibilityState={{ selected: on }}
            {...webAria({ 'aria-pressed': on })}
            onPress={() => { props.onChange(option.value); }}
            style={[styles.option, on ? styles.optionOn : null]}
          >
            <Text style={[styles.optionText, on ? styles.optionTextOn : null]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

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
  const params = useLocalSearchParams<{ about?: string | string[] }>();
  const draft = aboutDraft(params.about, localToday());
  const filled = useRef<string | null>(null);
  const { setDraft } = chat;
  const empty = chat.state.draft === '';
  useEffect(() => {
    // Once per address: what the person types afterwards, or a New chat, is theirs.
    if (draft === null || filled.current === draft) return;
    filled.current = draft;
    if (empty) setDraft(draft);
  }, [draft, empty, setDraft]);
  const [view, setView] = useState<View3>('chat');
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
    hasTownProfile: location.town.townId !== null,
    hasForecast: about.state.status === 'ready' && about.state.data.forecast.run !== null,
    coverage: { dayCount: location.coverage.dayCount, lastDate: location.coverage.lastDate },
  };
  const questions = panel.state.status === 'ready'
    ? panel.state.data.questions.filter((question) => panel.answered[question.id] === undefined).length
    : null;

  let body: React.ReactNode;
  if (desktop) {
    body = (
      <View style={styles.grid}>
        <View style={styles.main}>
          <AgentChat chat={chat} ctx={ctx} top={null} readOnlyId={readOnlyId} readOnlyLine={line} />
        </View>
        <View style={styles.side}>
          <ScrollView style={styles.fill} contentContainerStyle={styles.sideContent} testID="agent-side">
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
          </ScrollView>
        </View>
      </View>
    );
  } else {
    // On phones the header and the switch scroll with the view; on tablets the switch stays above it.
    const switcher = <Switch value={view} onChange={setView} questions={questions} />;
    const lead = head === null ? null : <View style={styles.lead}>{head}{switcher}</View>;
    body = (
      <View style={styles.fill}>
        {head === null ? <View style={styles.tabletSwitch}>{switcher}</View> : null}
        <View style={[styles.fill, view === 'chat' ? null : styles.hidden]}>
          <AgentChat chat={chat} ctx={ctx} top={lead} readOnlyId={readOnlyId} readOnlyLine={line} />
        </View>
        {view === 'chat' ? null : (
          <ScrollView style={styles.fill} contentContainerStyle={styles.sideContent} testID="agent-side">
            {lead}
            {view === 'questions' ? (
              <QuestionsSection panel={panel} locationName={location.name} readOnlyId={readOnlyId} />
            ) : (
              <>
                <ActivitySection panel={panel} />
                <BudgetSection budget={chat.state.budget} />
                <HowItWorks ctx={ctx} locationId={location.id} about={about.state} onRetryAbout={about.reload} />
              </>
            )}
          </ScrollView>
        )}
      </View>
    );
  }

  return (
    <View
      ref={root}
      style={styles.fill}
      onLayout={() => { root.current?.measureInWindow((_x, y) => { setTop(y); }); }}
    >
      <KeyboardAvoidingView behavior="padding" enabled={Platform.OS === 'ios'} keyboardVerticalOffset={top} style={styles.fill}>
        <Wrap style={styles.wrap}>{body}</Wrap>
      </KeyboardAvoidingView>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, backgroundColor: c.ground },
  wrap: { flex: 1, minHeight: 0, paddingTop: theme.space[4], paddingBottom: theme.space[4] },
  grid: { flex: 1, minHeight: 0, flexDirection: 'row', columnGap: theme.space.gutter },
  main: { flex: 8, minWidth: 0, minHeight: 0 },
  side: { flex: 4, minWidth: 0, minHeight: 0 },
  sideContent: { gap: theme.space[8], paddingBottom: theme.space[8] },
  hidden: { display: 'none' },
  lead: { gap: theme.space[4] },
  tabletSwitch: { paddingBottom: theme.space[3] },
  switch: { flexDirection: 'row', borderWidth: theme.stroke.hairline, borderColor: c.line, alignSelf: 'flex-start' },
  option: { minHeight: 44, paddingHorizontal: theme.space[4], justifyContent: 'center' },
  optionOn: { backgroundColor: c.mint },
  optionText: { ...theme.type.ui, color: c.white },
  optionTextOn: { color: c.onMint },
});
