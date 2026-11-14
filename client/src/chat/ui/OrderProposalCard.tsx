import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { ApiError } from '../../api/client';
import { orderUnitSchema } from '../../portal/orders/api';
import { LINE_QUANTITY_RULE, parseLineQuantity, REASON_RULE, ruleLine } from '../../portal/orders/words';
import { usePortal } from '../../portal/PortalProvider';
import { Actions, Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { FormField } from '../../portal/ui/FormField';
import { Eyebrow, Small } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { OrderCard } from '../useTuningChat';

// A propose_order_change or propose_order_rule card. The item and the delivery come from the stored call,
// which this card reads (GET .../order-proposals/:id). The owner types the quantity, a whole number from 0 to 999,
// checked before it is sent (#68 review N6). A remembered rule adds its change to every later order of the item
// (design Decision 6). Nothing is sent to a distributor.

const proposalSchema = z.object({
  proposal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('change'), status: z.enum(['open', 'saved', 'dismissed']), itemId: z.string(), delivery: z.string() }),
    z.object({
      kind: z.literal('rule'), status: z.enum(['open', 'saved', 'dismissed']), itemId: z.string(),
      situation: z.string().optional(), delta: z.number().optional(), unit: orderUnitSchema.optional(),
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
  const [checks, setChecks] = useState<{ quantity: string[]; reason: string[] }>({ quantity: [], reason: [] });
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
        <>
          <Small>
            {view.delta !== undefined && view.unit !== undefined && view.situation !== undefined
              ? ruleLine({ delta: view.delta, situation: view.situation }, view.unit)
              : view.situation ?? 'Remember this change.'}
          </Small>
          <Small>It applies to every later order of this item until you turn it off on Orders.</Small>
        </>
      ) : (
        <>
          <FormField
            label="Quantity"
            numeric
            keyboardType="number-pad"
            value={quantity}
            onChangeText={setQuantity}
            messages={checks.quantity}
            readOnly={readOnly}
            {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })}
          />
          <FormField
            label="Why"
            value={reason}
            onChangeText={setReason}
            maxLength={280}
            messages={checks.reason}
            readOnly={readOnly}
            {...(props.readOnlyId === null ? {} : { readOnlyId: props.readOnlyId })}
          />
        </>
      )}
      {error === null ? null : <ErrorNotice message={error} />}
      <Actions>
        <Button
          variant="primary"
          label={view.kind === 'rule' ? 'Remember' : 'Save'}
          disabled={readOnly || pending}
          onPress={() => {
            if (view.kind === 'rule') {
              void act({ action: 'save' });
              return;
            }
            const parsed = parseLineQuantity(quantity);
            const why = reason.trim();
            setChecks({ quantity: parsed === null ? [LINE_QUANTITY_RULE] : [], reason: why === '' ? [REASON_RULE] : [] });
            if (parsed !== null && why !== '') void act({ action: 'save', quantity: parsed, reason: why });
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
