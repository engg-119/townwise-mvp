import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { actionError } from '../../portal/files/copy';
import { locationHref } from '../../portal/routing';
import { Actions, Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { Eyebrow } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { ItemProposal } from '../api';
import type { ItemCard } from '../useTuningChat';
import { described } from './described';

// TownwiseAI proposed keeping text on Your data (propose_data_item, D28; docs/portal/tuning-chat.md section 2). The
// stream never carries the title or the text, so the card reads them from its own route once its turn is stored,
// and until then it waits. Keep on Your data writes exactly the stored text as an item; Not now folds the card to one
// line, recorded on the server, and the text can still be kept. A reply the server never saved has nothing to keep.

export interface ItemProposalActions {
  loadItem: (card: ItemCard) => Promise<ItemProposal>;
  keepItem: (card: ItemCard) => Promise<ItemProposal>;
  setItemAside: (card: ItemCard) => Promise<ItemProposal>;
}

export const ITEM_COPY = {
  eyebrow: 'Proposed for Your data',
  waiting: 'The text shows here when this reply finishes.',
  loading: 'Loading the text…',
  lost: 'This reply wasn’t saved, so there’s nothing to keep from it. Paste the text on Your data to keep it.',
  gone: 'This proposal isn’t available anymore.',
  keep: 'Keep on Your data',
  keeping: 'Keeping…',
  notNow: 'Not now',
  folded: 'Not now.',
  show: 'Show the text',
  kept: 'Kept on Your data.',
  keptGone: 'Kept on Your data, and deleted there since.',
  open: 'Open Your data',
} as const;

/** A refusal of Keep or Not now, in place on the card. */
export function itemErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t keep this.';
    if (error.code === 'files_unavailable') return 'File storage is off right now, so this can’t be kept.';
    if (error.status === 404) return ITEM_COPY.gone;
  }
  return actionError(error);
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === status;
}

type Host = React.ComponentRef<typeof View>;

export function ItemProposalCard(props: {
  card: ItemCard;
  locationId: string;
  actions: ItemProposalActions;
  readOnlyId: string | null;
}): React.JSX.Element {
  const { card, actions } = props;
  const { loadItem } = actions;
  const readOnly = props.readOnlyId !== null;
  const [proposal, setProposal] = useState<ItemProposal | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [gone, setGone] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<'save' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reopened, setReopened] = useState(false);
  const keptLine = useRef<Host>(null);
  const justKept = useRef(false);

  const { id, conversationId, stored } = card;
  const readable = stored === 'kept' && conversationId !== null;
  useEffect(() => {
    if (!readable) return undefined;
    let cancelled = false;
    loadItem({ id, conversationId, stored }).then(
      (loaded) => { if (!cancelled) { setProposal(loaded); setLoadError(null); } },
      (caught: unknown) => {
        if (cancelled) return;
        if (isStatus(caught, 404)) setGone(true);
        else setLoadError(caught);
      },
    );
    return () => { cancelled = true; };
  }, [readable, id, conversationId, stored, loadItem, generation]);

  // A Keep the person just made moves focus to the line that says so (the buttons it pressed are gone).
  useEffect(() => {
    if (justKept.current && proposal?.status === 'saved' && Platform.OS === 'web') keptLine.current?.focus();
    justKept.current = false;
  }, [proposal?.status]);

  const act = (action: 'save' | 'dismiss'): void => {
    if (pending !== null || readOnly) return;
    setPending(action);
    setError(null);
    (action === 'save' ? actions.keepItem(card) : actions.setItemAside(card)).then(
      (next) => {
        justKept.current = action === 'save' && next.status === 'saved';
        setPending(null);
        setReopened(false);
        setProposal(next);
      },
      (caught: unknown) => {
        setPending(null);
        if (isStatus(caught, 404)) setGone(true);
        else setError(itemErrorText(caught));
      },
    );
  };

  let body: React.ReactNode;
  if (stored === 'pending') {
    body = <Text style={styles.line}>{ITEM_COPY.waiting}</Text>;
  } else if (!readable) {
    body = (
      <View style={styles.row}>
        <Text style={styles.line}>{ITEM_COPY.lost}</Text>
        <LinkButton href={locationHref(props.locationId, 'data')} label={ITEM_COPY.open} />
      </View>
    );
  } else if (gone) {
    body = <Text style={styles.line}>{ITEM_COPY.gone}</Text>;
  } else if (loadError !== null) {
    body = <ErrorNotice error={loadError} onRetry={() => { setLoadError(null); setGeneration((value) => value + 1); }} />;
  } else if (proposal === null) {
    body = <LoadingLine text={ITEM_COPY.loading} minHeight={0} />;
  } else if (proposal.status === 'dismissed' && !reopened) {
    return (
      <View style={styles.row}>
        <Text style={styles.folded}>{ITEM_COPY.folded}</Text>
        <Button variant="link" label={ITEM_COPY.show} onPress={() => { setReopened(true); }} />
      </View>
    );
  } else {
    const saved = proposal.status === 'saved';
    body = (
      <>
        <Text style={styles.title}>{proposal.title}</Text>
        <ScrollView
          style={styles.text}
          role="region"
          aria-label={`Text of ${proposal.title}`}
          {...(Platform.OS === 'web' ? { tabIndex: 0 as const } : {})}
        >
          <Text selectable style={styles.textBody}>{proposal.text}</Text>
        </ScrollView>
        {saved ? (
          <View style={styles.row}>
            <View ref={keptLine} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
              <Text style={styles.kept}>{proposal.item === null ? ITEM_COPY.keptGone : ITEM_COPY.kept}</Text>
            </View>
            <LinkButton href={locationHref(props.locationId, 'data')} label={ITEM_COPY.open} />
          </View>
        ) : (
          <Actions>
            {/* An outline: the composer's button is the chat page's one primary (spec 15.6, D26). */}
            <Button
              variant="outline"
              label={pending === 'save' ? ITEM_COPY.keeping : ITEM_COPY.keep}
              disabled={readOnly || pending !== null}
              {...described(props.readOnlyId)}
              onPress={() => { act('save'); }}
            />
            <Button
              variant="link"
              label={ITEM_COPY.notNow}
              disabled={readOnly || pending !== null}
              {...described(props.readOnlyId)}
              onPress={() => { act('dismiss'); }}
            />
          </Actions>
        )}
        {error === null ? null : <ErrorNotice message={error} />}
      </>
    );
  }

  return (
    <View style={styles.card} role="group" aria-label={ITEM_COPY.eyebrow}>
      <Eyebrow>{ITEM_COPY.eyebrow}</Eyebrow>
      {body}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  // Square corners everywhere in the app (spec 15.6).
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline,
    borderColor: c.border, borderRadius: theme.radius.none,
  },
  title: { ...theme.type.ui, color: c.white },
  text: {
    maxHeight: 240, padding: theme.space[3], borderWidth: theme.stroke.hairline, borderColor: c.border, borderRadius: theme.radius.none,
  },
  textBody: { ...theme.type.sub, color: c.text2 },
  line: { ...theme.type.small, color: c.text2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: theme.space[4] },
  kept: { ...theme.type.sub, color: c.white },
  folded: { ...theme.type.small, color: c.text3 },
});
