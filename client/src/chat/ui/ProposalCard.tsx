import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { NoteForm } from '../../portal/locations/NoteForm';
import { draftOfContent } from '../../portal/locations/noteRules';
import { locationHref } from '../../portal/routing';
import { Actions, Button, LinkButton } from '../../portal/ui/Button';
import { DefinitionList } from '../../portal/ui/DataTable';
import { ErrorNotice } from '../../portal/ui/feedback';
import { Eyebrow } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { NoteProposal } from '../api';
import { EFFECT_LABEL, formatDates, guestsText, KIND_LABEL, weekdaysText } from '../format';
import type { ProposalCard as Card } from '../useTuningChat';
import { described } from './described';

// A note TownwiseAI proposed (spec P25). Save note saves it as shown; Edit first opens the note form with it
// filled in, and that form's save is the same proposal route with the edit; Not now folds the card to one line,
// recorded on the server, and it can still be saved. Dates and counts are data: mono, mint. Errors stay on the card.
// A card from a reply that is still streaming waits for it to end (the server keeps the proposal only then). One
// from a reply the server never kept says so, and its Save note goes through the notes route instead. D59 slice 4: a
// note TownwiseAI saved itself, the person having stated it plainly, reads saved with Undo (its change's own route) while
// the person may undo it, and says so once it was undone or changed since.

export interface ProposalActions {
  save: (cardId: string) => void;
  saveEdited: (cardId: string, note: NoteProposal) => Promise<void>;
  edit: (cardId: string) => void;
  cancelEdit: (cardId: string) => void;
  dismiss: (cardId: string) => void;
  reopen: (cardId: string) => void;
  undo: (cardId: string) => void;
}

type Host = React.ComponentRef<typeof View>;

function Data(props: { children: string }): React.JSX.Element {
  return <Text style={styles.data}>{props.children}</Text>;
}

export function ProposalCard(props: {
  card: Card;
  locationId: string;
  actions: ProposalActions;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { card, actions } = props;
  const { proposal } = card;
  const readOnly = props.readOnlyId !== null;
  const savedLine = useRef<Host>(null);
  const previous = useRef(card.status);
  // A save the person just made moves focus to the line that says so (the buttons it pressed are gone).
  useEffect(() => {
    if (previous.current === 'saving' && card.status === 'saved' && Platform.OS === 'web') savedLine.current?.focus();
    previous.current = card.status;
  }, [card.status]);
  // D59 slice 4: so does an Undo once it is answered (its button, and once undone Open Notes, go or change under it).
  const autoStatus = card.auto?.status;
  const previousAuto = useRef(autoStatus);
  useEffect(() => {
    if (previousAuto.current === 'undoing' && autoStatus !== 'undoing' && Platform.OS === 'web') savedLine.current?.focus();
    previousAuto.current = autoStatus;
  }, [autoStatus]);

  if (card.status === 'editing') {
    return (
      <NoteForm
        initial={draftOfContent(proposal)}
        editing={false}
        save={async (input) => {
          // A proposal's form never offers the guest-count mark (D67), which only a person's own note takes.
          if (input.effect === 'wrong_guest_count') return null;
          await actions.saveEdited(card.id, { ...input, effect: input.effect });
          return null;
        }}
        marks={false}
        onSaved={() => undefined}
        onCancel={() => { actions.cancelEdit(card.id); }}
        // The composer's button is the chat page's one primary (spec 15.6, D26).
        submitVariant="outline"
      />
    );
  }

  if (card.status === 'dismissed') {
    return (
      <View style={styles.folded}>
        <Text style={styles.foldedText}>Not now.</Text>
        <Button variant="link" label="Show the note" onPress={() => { actions.reopen(card.id); }} />
      </View>
    );
  }

  const weekdays = weekdaysText(proposal.weekdays);
  const guests = guestsText(proposal.expectedGuests);
  const items: { term: string; value: React.ReactNode }[] = [{ term: 'Kind', value: KIND_LABEL[proposal.kind] }];
  // The event's name (D49), the person's own words: plain text.
  if (proposal.title !== null && proposal.title !== undefined) items.push({ term: 'Event name', value: proposal.title });
  items.push({ term: proposal.startDate === proposal.endDate ? 'Date' : 'Dates', value: <Data>{formatDates(proposal)}</Data> });
  if (weekdays !== null) items.push({ term: 'Weekdays', value: <Data>{weekdays}</Data> });
  items.push({ term: 'Effect', value: EFFECT_LABEL[proposal.effect] });
  if (guests !== null) items.push({ term: 'Expected guests', value: <Data>{guests}</Data> });
  if (proposal.detail !== null) items.push({ term: 'Detail', value: proposal.detail });

  const saving = card.status === 'saving';
  const waiting = card.stored === 'pending';
  let footer: React.ReactNode;
  const { auto } = card;
  if (card.status === 'saved' && auto !== undefined) {
    const undoing = auto.status === 'undoing';
    footer = (
      <View style={styles.saved}>
        <View ref={savedLine} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
          <Text style={styles.savedText}>{autoLine(auto)}</Text>
        </View>
        {auto.status === 'undone' || auto.target === 'gone' ? null : <LinkButton href={locationHref(props.locationId, 'notes')} label="Open Notes" />}
        {(auto.status === 'applied' || undoing) && auto.undoable ? (
          <Button variant="link" label={undoing ? 'Undoing…' : 'Undo'} disabled={readOnly || undoing} {...described(props.readOnlyId)} onPress={() => { actions.undo(card.id); }} />
        ) : null}
      </View>
    );
  } else if (card.status === 'saved') {
    footer = (
      <View style={styles.saved}>
        <View ref={savedLine} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
          <Text style={styles.savedText}>{card.edited ? 'Saved to Notes, with your changes.' : 'Saved to Notes.'}</Text>
        </View>
        <LinkButton href={locationHref(props.locationId, 'notes')} label="Open Notes" />
      </View>
    );
  } else if (card.gone) {
    footer = null;
  } else {
    const off = readOnly || waiting || saving;
    footer = (
      <Actions>
        {/* An outline: the composer's button is the chat page's one primary (spec 15.6, D26). */}
        <Button variant="outline" label={saving ? 'Saving…' : 'Save note'} disabled={off} {...described(props.readOnlyId)} onPress={() => { actions.save(card.id); }} />
        <Button variant="link" label="Edit first" disabled={off} {...described(props.readOnlyId)} onPress={() => { actions.edit(card.id); }} />
        <Button variant="link" label="Not now" disabled={off} {...described(props.readOnlyId)} onPress={() => { actions.dismiss(card.id); }} />
      </Actions>
    );
  }

  return (
    <View style={styles.card} role="group" aria-label={auto === undefined ? 'Proposed note' : 'Note from your message'}>
      <Eyebrow>{auto === undefined ? 'Proposed note' : 'Note from your message'}</Eyebrow>
      <DefinitionList items={items} />
      {card.stored === 'lost' && card.status !== 'saved' ? (
        <Text style={styles.lost}>This reply wasn’t saved, so TownwiseAI didn’t keep this note. Save it here to add it to Notes.</Text>
      ) : null}
      {footer}
      {card.error === null ? null : <ErrorNotice message={card.error} />}
    </View>
  );
}

/** D59 slice 4: what became of a note TownwiseAI saved from the person's message. */
function autoLine(auto: NonNullable<Card['auto']>): string {
  if (auto.status === 'undone') return 'Undone. TownwiseAI took this note back out of Notes.';
  if (auto.status === 'adopted' || auto.target === 'changed') return 'Saved to Notes. You changed it since, so it’s yours.';
  if (auto.target === 'gone') return 'Saved to Notes, and deleted from Notes since.';
  return 'TownwiseAI saved this to Notes, as you said it.';
}

const c = theme.color;

const styles = StyleSheet.create({
  // Square corners everywhere in the app (spec 15.6).
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline,
    borderColor: c.border, borderRadius: theme.radius.none,
  },
  data: { ...theme.type.monoUi, color: c.mint },
  lost: { ...theme.type.small, color: c.text2 },
  saved: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4] },
  savedText: { ...theme.type.sub, color: c.white },
  folded: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[2] },
  foldedText: { ...theme.type.small, color: c.text3 },
});
