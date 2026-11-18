import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { hasCode } from '../../portal/errors';
import { dismissSetupProposal, fetchOrderSetup, type OrderSetup, type SetupProposal, type SetupRead } from '../../portal/orders/api';
import { plural } from '../../portal/format';
import { problemLine } from '../../portal/orders/proposal';
import { CARD_CHANGES_MAX, changeLine, moreChangesLine, READ_WEB_LINE, setupCardPreview, setupProposalHref } from '../../portal/orders/setupCard';
import { usePortal } from '../../portal/PortalProvider';
import { Actions, Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { Eyebrow, Small } from '../../portal/ui/text';
import { theme } from '../../theme';

// A propose_order_setup card (spec D56): ordering setup suggestions TownwiseAI wrote from a file attached to the
// conversation, as the server checked them (OrderProposalCard.tsx reads the card and hands it here). The card previews
// them against the setup as it is saved now, with the merge Ordering setup itself runs (portal/orders/setupCard.ts):
// what is new, each item already in the setup that would change, field by field, and what is left out. It saves
// nothing. Review opens Ordering setup with the suggestions in the unsaved draft, by the card's two ids; Not now sets
// the card aside for good (OrderProposalCard.tsx says so). The card lists the first ten changed items and says how many
// more Ordering setup lists. With nothing to open (the suggestions are in the setup, or none can be added) it offers nothing. Under view-as the server
// sends counts only, so the card says how many suppliers and items were suggested and nothing from the file.

export const SETUP_CARD_COPY = {
  title: 'Ordering setup suggestions',
  review: 'Review in Ordering setup',
  web: READ_WEB_LINE,
  gone: 'These suggestions aren’t available any more. The file they came from may have been turned off or deleted.',
  loadFailed: 'Townwise couldn’t load these suggestions. Reload the page to try again.',
  setAside: 'Set aside. Nothing was added. Ask TownwiseAI again if you want these suggestions back.',
  setupFailed: 'Townwise couldn’t load your ordering setup, so it can’t show what these suggestions would change. Reload the page to try again.',
} as const;

/** What staff see under view-as: how much was suggested, never a name or a note, and no action. */
function countsLine(counts: { suppliers: number; items: number }): string {
  return `TownwiseAI suggested ${plural(counts.suppliers, 'supplier', 'suppliers')} and ${plural(counts.items, 'item', 'items')} from an attached file. `
    + 'Their names aren’t shown while viewing as someone else.';
}

export function OrderSetupCard(props: {
  proposal: SetupProposal;
  locationId: string;
  conversationId: string;
  proposalId: string;
  readOnly: boolean;
  onDismissed: () => void;
}): React.JSX.Element {
  const { read, counts } = props.proposal;
  if (read === undefined) {
    return (
      <View style={styles.card}>
        <Eyebrow>{SETUP_CARD_COPY.title}</Eyebrow>
        <Small>{counts === undefined ? 'These suggestions aren’t shown here.' : countsLine(counts)}</Small>
      </View>
    );
  }
  return <Suggestions {...props} read={read} />;
}

function Suggestions(props: {
  proposal: SetupProposal;
  read: SetupRead;
  locationId: string;
  conversationId: string;
  proposalId: string;
  readOnly: boolean;
  onDismissed: () => void;
}): React.JSX.Element {
  const { api } = usePortal();
  const { locationId, conversationId, proposalId } = props;
  /** The setup as saved now: undefined while it loads, null when the location has none. */
  const [setup, setSetup] = useState<OrderSetup | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The card stopped being served after it loaded (its file was turned off or deleted): nothing is left to act on. */
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchOrderSetup(api, locationId).then(
      (answer) => { if (live) setSetup(answer.setup); },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [api, locationId]);

  if (gone) return <Small>{SETUP_CARD_COPY.gone}</Small>;
  if (failed) return <ErrorNotice message={SETUP_CARD_COPY.setupFailed} />;
  if (setup === undefined) return <LoadingLine text="Loading your ordering setup…" />;
  const preview = setupCardPreview(props.read, setup);

  async function dismiss(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await dismissSetupProposal(api, locationId, conversationId, proposalId);
      props.onDismissed();
    } catch (caught) {
      if (hasCode(caught, 404, 'not_found')) {
        setGone(true);
        return;
      }
      setError(caught instanceof ApiError && caught.kind === 'http' && caught.code === 'view_as_read_only'
        ? 'View-as is read-only, so this can’t be set aside.'
        : 'That didn’t go through. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.card}>
      <Eyebrow>{SETUP_CARD_COPY.title}</Eyebrow>
      {preview.lines.map((line) => <Small key={line}>{line}</Small>)}
      {preview.changesLead === null ? null : (
        <View style={styles.list}>
          <Small>{preview.changesLead}</Small>
          {preview.changes.slice(0, CARD_CHANGES_MAX).map((change) => <Small key={change.item}>{changeLine(change)}</Small>)}
          {moreChangesLine(preview.changes.length) === null ? null : <Small>{moreChangesLine(preview.changes.length)}</Small>}
        </View>
      )}
      {preview.problemsLead === null ? null : (
        <View style={styles.list}>
          <Small>{preview.problemsLead}</Small>
          {preview.problems.map((problem) => <Small key={problem.row}>{problemLine(problem)}</Small>)}
        </View>
      )}
      {props.proposal.readWeb && !preview.inSetup ? <Small>{SETUP_CARD_COPY.web}</Small> : null}
      {preview.closing === null ? null : <Small>{preview.closing}</Small>}
      {error === null ? null : <ErrorNotice message={error} />}
      {!preview.actionable || props.readOnly ? null : (
        <Actions>
          <LinkButton variant="primary" href={setupProposalHref(locationId, conversationId, proposalId)} label={SETUP_CARD_COPY.review} />
          <Button variant="outline" label="Not now" disabled={pending} onPress={() => { void dismiss(); }} />
        </Actions>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: theme.space[3] },
  list: { gap: theme.space[1] },
});
