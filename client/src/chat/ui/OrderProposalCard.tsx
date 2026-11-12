import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { ApiError } from '../../api/client';
import { usePortal } from '../../portal/PortalProvider';
import { Actions, Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { FormField } from '../../portal/ui/FormField';
import { Eyebrow, Small } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { OrderCard } from '../useTuningChat';

// A propose_order_change or propose_order_rule card. The item and the delivery come from the stored call,
// which this card reads. The owner types the quantity. Nothing is sent to a distributor.

const proposalSchema = z.object({
  proposal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('change'), status: z.enum(['open', 'saved', 'dismissed']), itemId: z.string(), delivery: z.string() }),
    z.object({
      kind: z.literal('rule'), status: z.enum(['open', 'saved', 'dismissed']), itemId: z.string(),
      situation: z.string().optional(), delta: z.number().optional(), unit: z.string().optional(),
    }),
  ]),
});

function path(locationId: string, card: OrderCard): `/${string}` | null {
  if (card.conversationId === null) return null;
  return `/api/org/locations/${encodeURIComponent(locationId)}/chat/${encodeURIComponent(card.conversationId)}/order-proposals/${encodeURIComponent(card.id)}`;
}

export function OrderProposalCard(props: { card: OrderCard; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { api } = usePortal();
  const { card } = props;
  const [view, setView] = useState<z.infer<typeof proposalSchema>['proposal'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const readable = card.stored === 'kept' && card.conversationId !== null;
  const target = path(props.locationId, card);

  useEffect(() => {
    if (!readable || target === null) return undefined;
    let live = true;
    void api.json(target, proposalSchema).then(
      (body) => { if (live) setView(body.proposal); },
      () => { if (live) setError('This proposal isn’t available.'); },
    );
    return () => { live = false; };
  }, [api, readable, target]);

  if (card.stored === 'lost') return <Small>This reply wasn’t saved, so there’s nothing to change.</Small>;
  if (!readable || view === null) return error === null ? <LoadingLine text="Loading the order…" /> : <ErrorNotice message={error} />;
  if (view.status === 'dismissed') return <Small>Not now.</Small>;
  if (view.status === 'saved') return <Small>{view.kind === 'rule' ? 'Remembered.' : 'Saved for this order.'}</Small>;

  async function act(body: unknown): Promise<void> {
    if (target === null) return;
    setPending(true);
    setError(null);
    try {
      const next = await api.json(target, proposalSchema, { method: 'POST', body });
      setView(next.proposal);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.kind === 'http' && caught.code === 'view_as_read_only'
        ? 'View-as is read-only, so this can’t be saved.'
        : 'That didn’t save. Try again.');
    } finally {
      setPending(false);
    }
  }

  const readOnly = props.readOnlyId !== null;
  return (
    <View style={styles.card}>
      <Eyebrow>{view.kind === 'rule' ? 'Remember this' : 'Change this line'}</Eyebrow>
      {view.kind === 'rule' ? (
        <Small>{view.situation ?? 'Remember this change for next time.'}</Small>
      ) : (
        <>
          <FormField label="Quantity" numeric value={quantity} onChangeText={setQuantity} readOnly={readOnly} {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })} />
          <FormField label="Why" value={reason} onChangeText={setReason} readOnly={readOnly} {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })} />
        </>
      )}
      {error === null ? null : <ErrorNotice message={error} />}
      <Actions>
        <Button
          variant="primary"
          label={view.kind === 'rule' ? 'Remember' : 'Save'}
          disabled={readOnly || pending}
          onPress={() => {
            if (view.kind === 'rule') void act({ action: 'save' });
            else void act({ action: 'save', quantity: Number(quantity), reason });
          }}
        />
        <Button variant="outline" label="Not now" disabled={readOnly || pending} onPress={() => { void act({ action: 'dismiss' }); }} />
      </Actions>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: theme.space[3] },
});
