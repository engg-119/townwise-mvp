import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { z } from 'zod';

import { ApiError } from '../../api/client';
import { hasCode } from '../../portal/errors';
import { orderUnitSchema, setupProposalSchema } from '../../portal/orders/api';
import { amount, LINE_QUANTITY_RULE, parseLineQuantity, REASON_RULE, ruleLine } from '../../portal/orders/words';
import { usePortal } from '../../portal/PortalProvider';
import { Actions, Button } from '../../portal/ui/Button';
import { ErrorNotice, LoadingLine } from '../../portal/ui/feedback';
import { FormField } from '../../portal/ui/FormField';
import { Eyebrow, Small } from '../../portal/ui/text';
import { theme } from '../../theme';
import type { OrderCard } from '../useTuningChat';
import { OrderSetupCard, SETUP_CARD_COPY } from './OrderSetupCard';

// A propose_order_change or propose_order_rule card. The item and the delivery come from the stored call,
// which this card reads (GET .../order-proposals/:id). The owner types the quantity, a whole number from 0 to 999,
// checked before it is sent (#68 review N6). A remembered rule adds its change to every later order of the item
// (design Decision 6); Remember sends the situation the card showed, so a later edit to the item answers 409
// `rule_changed` instead of remembering something the owner never saw. A saved change card shows the edit stored
// under its id; a save of another quantity or reason (a retry after the first was stored) answers 409 `card_saved`
// with that edit, which the card then shows (#68 second review N3). Nothing is sent to a distributor. A
// propose_order_setup card (D56) is read here too and drawn by OrderSetupCard: it is only ever open or set aside.

const cardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('change'), status: z.enum(['open', 'saved', 'dismissed']), itemId: z.string(), delivery: z.string(),
    quantity: z.number().optional(), unit: orderUnitSchema.optional(), reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal('rule'), status: z.enum(['open', 'saved', 'dismissed']), itemId: z.string(),
    situation: z.string().optional(), delta: z.number().optional(), unit: orderUnitSchema.optional(),
  }),
  setupProposalSchema,
]);
const proposalSchema = z.object({ proposal: cardSchema });
type CardView = z.infer<typeof cardSchema>;

/** 'Saved for this order: 10 cases, “Game day”.' The reason is the owner's own words. */
function savedLine(view: Exclude<CardView, { kind: 'setup' }>): string {
  if (view.kind === 'rule') return 'Remembered.';
  if (view.quantity === undefined || view.unit === undefined || view.reason === undefined) return 'Saved for this order.';
  return `Saved for this order: ${amount(view.quantity, view.unit)}, “${view.reason}”.`;
}

function path(locationId: string, card: OrderCard): `/${string}` | null {
  if (card.conversationId === null) return null;
  return `/api/org/locations/${encodeURIComponent(locationId)}/chat/${encodeURIComponent(card.conversationId)}/order-proposals/${encodeURIComponent(card.id)}`;
}

export function OrderProposalCard(props: { card: OrderCard; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { api } = usePortal();
  const { card } = props;
  const [view, setView] = useState<CardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when a save found the card saved already with another edit, which the saved line then shows. */
  const [kept, setKept] = useState(false);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState<{ quantity: string[]; reason: string[] }>({ quantity: [], reason: [] });
  const [pending, setPending] = useState(false);
  /** A setup card the person just set aside: its line takes focus, which the pressed button gave up. */
  const [setAsideNow, setSetAsideNow] = useState(false);
  const asideRef = useRef<React.ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (setAsideNow) asideRef.current?.focus();
  }, [setAsideNow]);
  const readable = card.stored === 'kept' && card.conversationId !== null;
  const target = path(props.locationId, card);

  useEffect(() => {
    if (!readable || target === null) return undefined;
    let live = true;
    void api.json(target, proposalSchema).then(
      (body) => { if (live) setView(body.proposal); },
      (caught: unknown) => {
        if (!live) return;
        // A setup card is no longer served once its file is turned off or deleted (D56): say that, not an error.
        if (card.setup !== true) setError('This proposal isn’t available.');
        else setError(hasCode(caught, 404, 'not_found') ? SETUP_CARD_COPY.gone : SETUP_CARD_COPY.loadFailed);
      },
    );
    return () => { live = false; };
  }, [api, readable, target, card.setup]);

  if (card.stored === 'lost') return <Small>This reply wasn’t saved, so there’s nothing to change.</Small>;
  if (!readable || view === null) {
    return error === null
      ? <LoadingLine text={card.setup === true ? 'Loading TownwiseAI’s suggestions…' : 'Loading the order…'} />
      : error === SETUP_CARD_COPY.gone ? <Small>{error}</Small> : <ErrorNotice message={error} />;
  }
  if (view.status === 'dismissed' && view.kind === 'setup') {
    // Set aside is final for this card, so the line says how to get the suggestions back.
    return (
      <View ref={asideRef} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
        <Small>{SETUP_CARD_COPY.setAside}</Small>
      </View>
    );
  }
  if (view.status === 'dismissed') return <Small>Not now.</Small>;
  if (view.kind === 'setup') {
    return (
      <OrderSetupCard
        proposal={view}
        locationId={props.locationId}
        conversationId={card.conversationId ?? ''}
        proposalId={card.id}
        readOnly={props.readOnlyId !== null}
        onDismissed={() => {
          setSetAsideNow(true);
          setView({ ...view, status: 'dismissed' });
        }}
      />
    );
  }
  if (view.status === 'saved') {
    return (
      <View style={styles.card}>
        {kept ? <ErrorNotice message="This card was already saved with another quantity or reason, so the one you just sent wasn’t saved. Change it on Orders if you need to." /> : null}
        <Small>{savedLine(view)}</Small>
      </View>
    );
  }

  async function act(body: unknown): Promise<void> {
    if (target === null) return;
    setPending(true);
    setError(null);
    try {
      const next = await api.json(target, proposalSchema, { method: 'POST', body });
      setView(next.proposal);
    } catch (caught) {
      if (caught instanceof ApiError && caught.kind === 'http' && caught.code === 'view_as_read_only') {
        setError('View-as is read-only, so this can’t be saved.');
      } else if (hasCode(caught, 409, 'card_saved') && caught instanceof ApiError) {
        const stored = cardSchema.safeParse(caught.detail?.proposal);
        if (stored.success) {
          setKept(true);
          setView(stored.data);
        } else setError('This card was already saved. Look at Orders for the quantity it has.');
      } else if (hasCode(caught, 409, 'rule_changed')) {
        setError('This item’s latest edit changed since this card was shown, so nothing was remembered. Look at Orders again for the edit it has now.');
      } else setError('That didn’t save. Try again.');
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
              void act({ action: 'save', ...(view.situation === undefined ? {} : { situation: view.situation }) });
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
