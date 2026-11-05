import { useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { EFFECT_LABEL, formatDates, formatDay, guestsText, KIND_LABEL, weekdaysText } from '../../../../../../src/chat/format';
import { canSend, useTuningChat, type ChatMessage, type ProposalCard, type TuningChat } from '../../../../../../src/chat/useTuningChat';
import { useOrgRefreshOnLeave } from '../../../../../../src/portal/locations/parts';
import { usePortal, useReadOnly } from '../../../../../../src/portal/PortalProvider';
import { useScrollingHead } from '../../../../../../src/portal/shell/LocationShell';
import { webAria } from '../../../../../../src/portal/ui/aria';
import { Button as PortalButton } from '../../../../../../src/portal/ui/Button';
import { ReadOnlyLine } from '../../../../../../src/portal/ui/feedback';
import { theme } from '../../../../../../src/theme';
import { Button, Loading, Message, Screen } from '../../../../../../src/ui';

// The tuning chat for one location (docs/portal/tuning-chat.md, section 7). The logic is in useTuningChat;
// this file only lays it out. Nothing here animates: new text and the scroll to it appear at once.
// Under view-as (spec 15.5) staff can read the target's conversations, and every write control (the composer,
// Send or Stop, Add note, New conversation) stays in place, disabled, described by the one read-only line.
// The location's header (the page's one h1, with the name) and its tabs come from the layout. On phones they are
// compact (the name on one line, no eyebrow or switcher) and sit at the top of the thread, so they scroll away
// and the conversation gets the screen; wider screens keep the full header above the chat.

const READ_ONLY_ID = 'chat-ro';

export default function TuningChatScreen(): React.JSX.Element {
  // The portal's client, so the access errors of spec 4.3 re-read GET /api/me and route again.
  const { api } = usePortal();
  const router = useRouter();
  const params = useLocalSearchParams<{ locationId: string }>();
  const locationId = typeof params.locationId === 'string' ? params.locationId : '';
  // A note added from a card changes the location's notes count: the organization is read again on leaving.
  const markOrgStale = useOrgRefreshOnLeave();
  const chat = useTuningChat(api, locationId, markOrgStale);
  const locationHead = useScrollingHead();
  // iOS: the keyboard avoider measures itself from its parent, so it is offset by the header above it.
  const root = useRef<React.ComponentRef<typeof View>>(null);
  const [top, setTop] = useState(0);
  const head = (
    <Button
      variant="link"
      label="Back to locations"
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/dashboard');
      }}
    />
  );

  return (
    <View
      ref={root}
      style={styles.fill}
      onLayout={() => { root.current?.measureInWindow((_x, y) => { setTop(y); }); }}
    >
      <KeyboardAvoidingView behavior="padding" enabled={Platform.OS === 'ios'} keyboardVerticalOffset={top} style={styles.fill}>
        <Screen>
          {locationHead === null ? head : null}
          <Body chat={chat} top={locationHead === null ? null : <>{locationHead}{head}</>} />
        </Screen>
      </KeyboardAvoidingView>
    </View>
  );
}

/** `top`: on phones, the location's header and the chat's back link, at the top of what scrolls. */
function Body({ chat, top }: { chat: TuningChat; top: React.ReactNode }): React.JSX.Element {
  const { state } = chat;
  const { readOnly, line } = useReadOnly();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  if (state.status === 'loading') return <>{top}<Loading /></>;
  if (state.status === 'not_found') return <>{top}<Message>This location wasn’t found.</Message></>;
  if (state.status === 'failed') {
    return (
      <>
        {top}
        <Message tone="error">{state.loadError ?? 'Something went wrong.'}</Message>
        <Button label="Try again" onPress={chat.retry} />
      </>
    );
  }
  if (!state.enabled) return <>{top}<Message>The tuning chat isn’t turned on yet.</Message></>;

  const open = state.conversationId !== null || state.messages.length > 0;
  const replying = state.messages.find((message) => message.state === 'streaming');
  const status = state.tool ?? (replying?.text === '' ? 'Thinking' : null);
  return (
    <>
      <ScrollView
        ref={scroll}
        testID="chat-thread"
        style={styles.fill}
        contentContainerStyle={styles.thread}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => { if (open) scroll.current?.scrollToEnd({ animated: false }); }}
      >
        {top}
        {open ? (
          readOnly
            ? <PortalButton variant="link" label="New conversation" disabled describedBy={READ_ONLY_ID} />
            : <Button variant="link" label="New conversation" disabled={state.streaming} onPress={chat.newConversation} />
        ) : (
          <Conversations chat={chat} />
        )}
        {state.conversationLoading ? <Text style={styles.muted}>Loading the conversation…</Text> : null}
        {state.messages.map((message) => <MessageView key={message.key} message={message} chat={chat} readOnly={readOnly} />)}
        {state.streaming && status !== null ? (
          <Text style={styles.status} accessibilityLiveRegion="polite" aria-live="polite">{status}</Text>
        ) : null}
      </ScrollView>
      {state.error === null ? null : <Message tone="error">{state.error}</Message>}
      <ReadOnlyLine text={line} nativeID={READ_ONLY_ID} />
      {state.budget?.exhausted === true ? (
        <Message>This month’s chat budget is used up. The chat opens again next month.</Message>
      ) : (
        <Composer chat={chat} readOnly={readOnly} />
      )}
    </>
  );
}

function Conversations({ chat }: { chat: TuningChat }): React.JSX.Element {
  const { conversations } = chat.state;
  return (
    <View style={styles.list}>
      <Text role="heading" {...webAria({ 'aria-level': 2 })} style={styles.label}>Conversations</Text>
      {conversations.length === 0 ? (
        <Text style={styles.muted}>No conversations yet. Ask about a closure, a private event or an unusual day.</Text>
      ) : null}
      {conversations.map((conversation) => {
        const day = formatDay(conversation.updatedAt);
        return (
          <Pressable
            key={conversation.id}
            accessibilityRole="button"
            accessibilityLabel={day === '' ? conversation.title : `${conversation.title}, ${day}`}
            onPress={() => { chat.openConversation(conversation.id); }}
            style={(press) => [styles.row, press.pressed && styles.rowPressed]}
          >
            <Text style={styles.rowTitle} numberOfLines={1}>{conversation.title}</Text>
            <Text style={styles.rowDate}>{day}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function MessageView({ message, chat, readOnly }: { message: ChatMessage; chat: TuningChat; readOnly: boolean }): React.JSX.Element {
  const user = message.role === 'user';
  return (
    <View style={[styles.message, user && styles.userMessage]}>
      <Text style={styles.label}>{user ? 'You' : 'Assistant'}</Text>
      {message.text === '' ? null : <Text selectable style={styles.text}>{message.text}</Text>}
      {message.proposals.map((card) => (card.status === 'dismissed' ? null : (
        <ProposalView
          key={card.key}
          card={card}
          readOnly={readOnly}
          onAdd={() => { chat.addNote(message.key, card.key); }}
          onDismiss={() => { chat.dismiss(message.key, card.key); }}
        />
      )))}
      {message.note === null ? null : <Text style={styles.muted}>{message.note}</Text>}
    </View>
  );
}

function ProposalView(props: { card: ProposalCard; readOnly: boolean; onAdd: () => void; onDismiss: () => void }): React.JSX.Element {
  const { card } = props;
  const { proposal } = card;
  const weekdays = weekdaysText(proposal.weekdays);
  const guests = guestsText(proposal.expectedGuests);
  const adding = card.status === 'adding';
  return (
    <View style={styles.card}>
      <Text style={styles.label}>Proposed note</Text>
      <Text style={styles.cardTitle}>{KIND_LABEL[proposal.kind]}</Text>
      <Text style={styles.data}>{formatDates(proposal)}</Text>
      {weekdays === null ? null : <Text style={styles.data}>{weekdays}</Text>}
      <Text style={styles.text}>{EFFECT_LABEL[proposal.effect]}</Text>
      {guests === null ? null : <Text style={styles.data}>{guests}</Text>}
      {proposal.detail === null ? null : <Text style={styles.detail}>{proposal.detail}</Text>}
      {card.status === 'added' ? <Message>Note added.</Message> : (
        <View style={styles.actions}>
          {props.readOnly
            ? <PortalButton label="Add note" disabled describedBy={READ_ONLY_ID} />
            : <Button label={adding ? 'Adding…' : 'Add note'} disabled={adding} onPress={props.onAdd} />}
          <Button variant="link" label="Dismiss" disabled={adding} onPress={props.onDismiss} />
        </View>
      )}
      {card.error === null ? null : <Message tone="error">{card.error}</Message>}
    </View>
  );
}

function Composer({ chat, readOnly }: { chat: TuningChat; readOnly: boolean }): React.JSX.Element {
  const { state } = chat;
  let action: React.JSX.Element;
  if (readOnly) action = <PortalButton label={state.streaming ? 'Stop' : 'Send'} disabled describedBy={READ_ONLY_ID} />;
  else if (state.streaming) action = <Button label="Stop" onPress={chat.stop} />;
  else action = <Button label="Send" disabled={!canSend(state)} onPress={chat.send} />;
  return (
    <View style={styles.composer}>
      <Text style={styles.fieldLabel}>Message</Text>
      <TextInput
        accessibilityLabel="Message"
        value={state.draft}
        onChangeText={chat.setDraft}
        editable={!readOnly}
        {...webAria({ 'aria-readonly': readOnly ? true : undefined, 'aria-describedby': readOnly ? READ_ONLY_ID : undefined })}
        multiline
        maxLength={4000}
        placeholder="Ask about this location"
        placeholderTextColor={theme.color.text3}
        style={[styles.input, readOnly ? styles.inputReadOnly : null]}
      />
      {action}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: c.ground },
  thread: { gap: theme.space[4], paddingBottom: theme.space[4] },
  list: { gap: theme.space[2] },
  label: { ...theme.type.label, color: c.text3 },
  muted: { ...theme.type.small, color: c.text3 },
  status: { ...theme.type.small, color: c.text2 },
  row: {
    minHeight: 44, justifyContent: 'center', paddingVertical: theme.space[2], gap: theme.space[1],
    borderBottomWidth: theme.stroke.hairline, borderBottomColor: c.border,
  },
  rowPressed: { backgroundColor: c.raised },
  rowTitle: { ...theme.type.ui, color: c.white },
  rowDate: { ...theme.type.small, color: c.text3 },
  message: { gap: theme.space[2] },
  // Square corners everywhere in the app (spec 15.6).
  userMessage: {
    padding: theme.space[3], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  text: { ...theme.type.sub, color: c.white },
  card: {
    gap: theme.space[2], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline,
    borderColor: c.border, borderRadius: theme.radius.none,
  },
  cardTitle: { ...theme.type.ui, color: c.white },
  // Dates and guest counts are the note's data: mint, in the mono face.
  data: { ...theme.type.monoUi, color: c.mint },
  detail: { ...theme.type.small, color: c.text2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space[4] },
  composer: { gap: theme.space[2] },
  fieldLabel: { ...theme.type.ui, color: c.white },
  input: {
    ...theme.type.sub, minHeight: 44, maxHeight: 160, paddingHorizontal: 12, paddingVertical: 10, color: c.white,
    backgroundColor: c.ground, borderWidth: 1, borderColor: c.line, borderRadius: 0, textAlignVertical: 'top',
  },
  inputReadOnly: { color: c.text3, borderColor: c.border },
});
