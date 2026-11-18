import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { usePortal } from '../PortalProvider';
import { useLocation } from '../shell/LocationShell';
import { LoadingLine, Messages } from '../ui/feedback';
import { Section } from '../ui/layout';
import { Small } from '../ui/text';
import { fetchSetupProposal, type OrderSetup, type SetupRead } from './api';
import { importProposal, problemLine, proposalSummary, type ProposalImport } from './proposal';
import {
  changeLine, CHAT_CUT, NAMES_UNCHECKED_LINE, PAGE_WEB_LINE, pageChangesLead, proposalParam, setupCardPreview, type ItemChange,
} from './setupCard';
import type { SetupDraft } from './setupDraft';

// Ordering setup opened from a TownwiseAI card (spec D56, P31), on both platforms. `?proposal=` names the card by a
// conversation's id and a tool call's id, checked by pattern before anything is asked. While the card is open its
// suggestions merge into the unsaved draft once, through the merge a read on this page uses (proposal.ts), and the
// section, which sits first on the page and takes focus once the merge lands so it is in view, says what that did in
// one list, with the cautions the chat's card gave (names not checked against a picture, web pages read), then lists
// each item already in the setup that changed, field by field. Nothing saves: the owner sets each new item's par and presses Save. After "Load their
// changes" replaces the draft the suggestions merge again, into the fresh one. Once a save goes through this stops for
// that card and drops the query in place, so neither a reload nor the same address again merges over what was saved;
// another card named in the same page starts clean. A card set aside, or no longer served (its file was
// turned off or deleted), says so and leaves the draft alone. Under view-as nothing is asked or merged.

export const PROPOSAL_COPY = {
  heading: 'Suggestions from TownwiseAI',
  loading: 'Loading TownwiseAI’s suggestions…',
  dismissed: 'You set these suggestions aside in TownwiseAI, so nothing was added here.',
  unavailable: 'These suggestions aren’t available any more, so nothing was added here. The file they came from may have been turned off or deleted.',
  failed: 'Townwise couldn’t load TownwiseAI’s suggestions, so nothing was added here. Reload the page to try again.',
  readOnly: 'View-as is read-only, so TownwiseAI’s suggestions weren’t added to this draft.',
} as const;

type Card =
  | { readonly kind: 'loading' }
  | { readonly kind: 'open'; readonly read: SetupRead; readonly readWeb: boolean }
  | { readonly kind: 'said'; readonly text: string };

export function SetupProposal(props: {
  draft: SetupDraft;
  /** The setup as saved, which the list of changes is told against, as on the chat's card. */
  saved: OrderSetup | null;
  /** Puts a merge in the draft, with its marks, leaving the page's notice as it is (SetupEditor's applyProposal). */
  apply: (result: ProposalImport) => void;
  readOnly: boolean;
  /** How many times the editor replaced its draft with the saved setup ("Load their changes"). */
  loads: number;
  /** How many saves went through since the page opened. */
  saves: number;
  /** Told whether an open card's suggestions are in play, so the editor's "Load their changes" can say they were added again. */
  onOpen: (open: boolean) => void;
}): React.JSX.Element | null {
  const { api } = usePortal();
  const { location } = useLocation();
  const router = useRouter();
  const params = useLocalSearchParams<{ proposal?: string | string[] }>();
  const target = proposalParam(params.proposal);
  const conversationId = target?.conversationId ?? null;
  const proposalId = target?.proposalId ?? null;
  const { readOnly, loads, saves } = props;
  /** The card the address names, or null. Everything below is kept by it, so another card starts clean. */
  const named = conversationId === null || proposalId === null ? null : `${conversationId}.${proposalId}`;
  const [loaded, setLoaded] = useState<{ readonly named: string; readonly card: Card } | null>(null);
  const [merged, setMerged] = useState<{
    readonly named: string; readonly result: ProposalImport; readonly changes: readonly ItemChange[]; readonly namesUnchecked: boolean;
  } | null>(null);
  /** The cards a save went through for, in this page: none of them is read or merged again. */
  const [finished, setFinished] = useState<readonly string[]>([]);
  /** The saves counted when the address last named this card: one more means a save went through with it open. */
  const [since, setSince] = useState({ named, saves });
  if (since.named !== named) setSince({ named, saves });
  const savedNow = named !== null && since.named === named && saves > since.saves;
  if (savedNow && !finished.includes(named)) setFinished([...finished, named]);
  const stopped = named === null || savedNow || finished.includes(named);
  const card = useMemo<Card>(() => (loaded !== null && loaded.named === named ? loaded.card : { kind: 'loading' }), [loaded, named]);
  const shown = merged !== null && merged.named === named ? merged : null;
  /** The editor's draft and apply as of the last render, for the merge. */
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
    props.onOpen(!readOnly && !stopped && card.kind === 'open');
  });
  /** The section, which takes focus (and so scrolls into view) the first time a card's suggestions are merged. */
  const section = useRef<React.ComponentRef<typeof View>>(null);
  const shownFor = merged !== null && merged.named === named ? merged.named : null;
  const arrivedAt = useRef<string | null>(null);
  useEffect(() => {
    if (shownFor === null || arrivedAt.current === shownFor) return;
    arrivedAt.current = shownFor;
    section.current?.focus();
  }, [shownFor]);
  /** The card and the editor's `loads` the suggestions were last merged at: once per card and per draft it loaded. */
  const mergedAt = useRef<string | null>(null);

  useEffect(() => {
    if (conversationId === null || proposalId === null || named === null || readOnly || stopped) return undefined;
    let live = true;
    const say = (next: Card): void => { if (live) setLoaded({ named, card: next }); };
    void fetchSetupProposal(api, location.id, conversationId, proposalId).then(
      (proposal) => {
        if (proposal.status !== 'open') say({ kind: 'said', text: PROPOSAL_COPY.dismissed });
        // Without the suggestions (a counts-only answer, as under view-as) there is nothing to merge.
        else if (proposal.read === undefined) say({ kind: 'said', text: PROPOSAL_COPY.unavailable });
        else say({ kind: 'open', read: proposal.read, readWeb: proposal.readWeb });
      },
      (caught: unknown) => { say({ kind: 'said', text: hasCode(caught, 404, 'not_found') ? PROPOSAL_COPY.unavailable : PROPOSAL_COPY.failed }); },
    );
    return () => { live = false; };
  }, [api, location.id, conversationId, proposalId, named, readOnly, stopped]);

  useEffect(() => {
    const at = `${named ?? ''}:${String(loads)}`;
    if (named === null || card.kind !== 'open' || stopped || mergedAt.current === at) return;
    mergedAt.current = at;
    const next = importProposal(card.read, latest.current.draft);
    // What the chat's card listed, told against the saved setup: each item already there that would change.
    const { changes, namesUnchecked } = setupCardPreview(card.read, latest.current.saved);
    latest.current.apply(next);
    setMerged({ named, result: next, changes, namesUnchecked });
  }, [card, named, loads, stopped]);

  // A save went through with this card open: it is remembered above, and the query is dropped in place, so neither a
  // reload nor the same address again merges over what was saved.
  useEffect(() => {
    if (savedNow) router.setParams({ proposal: undefined });
  }, [savedNow, router]);

  if (named === null || stopped) return null;
  const problemsLead = shown !== null && shown.result.problems.length > 0;
  // One list for what the merge did and its cautions; the lead-in to the problems goes above their own rows.
  const summary = shown === null ? [] : [
    ...proposalSummary(shown.result, 'file', CHAT_CUT).slice(0, problemsLead ? -1 : undefined),
    ...(shown.namesUnchecked ? [NAMES_UNCHECKED_LINE] : []),
    ...(card.kind === 'open' && card.readWeb ? [PAGE_WEB_LINE] : []),
  ];
  return (
    <View ref={section} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}>
    <Section title={PROPOSAL_COPY.heading}>
      {readOnly ? <Small>{PROPOSAL_COPY.readOnly}</Small> : null}
      {!readOnly && card.kind === 'loading' ? <LoadingLine text={PROPOSAL_COPY.loading} minHeight={44} /> : null}
      {!readOnly && card.kind === 'said' ? <Messages live="status" items={[card.text]} /> : null}
      {!readOnly && shown !== null ? (
        <View style={styles.stack}>
          <Messages live="status" items={summary} />
          {shown.changes.length === 0 ? null : (
            <View style={styles.rows}>
              <Small>{pageChangesLead(shown.changes.length)}</Small>
              <Messages items={shown.changes.map(changeLine)} />
            </View>
          )}
          {shown.result.problems.length === 0 ? null : (
            <View style={styles.rows}>
              <Small>{proposalSummary(shown.result, 'file', CHAT_CUT).at(-1)}</Small>
              <Messages items={shown.result.problems.map(problemLine)} />
            </View>
          )}
        </View>
      ) : null}
    </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space[3] },
  rows: { gap: theme.space[2] },
});
