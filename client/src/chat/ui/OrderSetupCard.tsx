import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '../../api/client';
import { hasCode } from '../../portal/errors';
import { dismissSetupProposal, fetchOrderSetup, type OrderSetup, type SetupProposal } from '../../portal/orders/api';
import { problemLine } from '../../portal/orders/proposal';
import { changeLine, setupCardPreview, setupProposalHref } from '../../portal/orders/setupCard';
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
// the card aside. Once the suggestions are in the setup the card says so and offers nothing. Under view-as it shows the
// preview with no actions.

export const SETUP_CARD_COPY = {
  title: 'Ordering setup suggestions',
  review: 'Review in Ordering setup',
  web: 'This reply also read web pages, which Townwise didn’t check. Look over each change before you save.',
  gone: 'These suggestions aren’t available any more. The file they came from may have been turned off or deleted.',
  setupFailed: 'Townwise couldn’t load your ordering setup, so it can’t show what these suggestions would change. Reload the page to try again.',
} as const;

export function OrderSetupCard(props: {
  proposal: SetupProposal;
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
  const preview = setupCardPreview(props.proposal.read, setup);

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
          {preview.changes.map((change) => <Small key={change.item}>{changeLine(change)}</Small>)}
        </View>
      )}
      {preview.problemsLead === null ? null : (
        <View style={styles.list}>
          <Small>{preview.problemsLead}</Small>
          {preview.problems.map((problem) => <Small key={problem.row}>{problemLine(problem)}</Small>)}
        </View>
      )}
      {props.proposal.readWeb && !preview.inSetup ? <Small>{SETUP_CARD_COPY.web}</Small> : null}
      {error === null ? null : <ErrorNotice message={error} />}
      {preview.inSetup || props.readOnly ? null : (
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
