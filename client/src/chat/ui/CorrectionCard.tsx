import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../../api/client';
import { localToday } from '../../portal/locations/dates';
import { usePortal } from '../../portal/PortalProvider';
import { APPLY_NOTICES, CORRECTION, correctionDoneLine, correctionFieldLines, correctionProposedLine } from '../../portal/research/copy';
import { calendarHref } from '../../portal/routing';
import { Actions, Button, LinkButton } from '../../portal/ui/Button';
import { ErrorNotice } from '../../portal/ui/feedback';
import { Eyebrow, Small } from '../../portal/ui/text';
import { theme } from '../../theme';
import { undoChange, undoErrorFinal, undoErrorText } from '../agentChanges';
import { applyCorrection, type CorrectionCard as Card } from '../corrections';
import { described } from './described';

// D66 (openspec change town-research-agent, design decision 12): the card a correct_calendar_event call draws, from its
// stored or streamed `tool` part (corrections.ts). A correction TownwiseAI made says what it did on this location's
// calendar, with Undo through the change's own route (the same as its line in the activity); one it proposed in a
// conversation that read a web page or a file shows the change with Apply, which sends the person's own edit on a
// fresh read of the event, so the tap is theirs (Reset on the Calendar undoes it). The card names no event title: the
// call's views carry ids and the proposed values only. Under view-as both buttons are disabled, described by the
// read-only line. Its state is the card's own: a reload reads the stored part again, and Apply then finds the change
// already made and sends nothing.

/** Apply's refusals in words (the API's codes, as the Calendar's edit sheet reads them). */
function applyErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'view_as_read_only') return APPLY_NOTICES.viewAs;
    if (error.code === 'too_many_edits') return APPLY_NOTICES.tooManyEdits;
    if (error.status === 404) return APPLY_NOTICES.gone;
    if (error.status === 400) return APPLY_NOTICES.invalid;
  }
  return APPLY_NOTICES.failed;
}

interface UndoState { status: 'applied' | 'undoing' | 'undone'; error: string | null; final: boolean }
interface ApplyState { status: 'open' | 'applying' | 'applied' | 'gone'; error: string | null }

function AppliedBody(props: { card: Extract<Card, { kind: 'applied' }>; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { api } = usePortal();
  const { card } = props;
  const [state, setState] = useState<UndoState>({ status: 'applied', error: null, final: false });
  const undo = (): void => {
    if (state.status !== 'applied') return;
    setState({ status: 'undoing', error: null, final: false });
    undoChange(api, props.locationId, card.changeId).then(
      // An Undo the activity already made answers undone too.
      (after) => { setState({ status: after.status === 'undone' ? 'undone' : 'applied', error: null, final: after.status !== 'undone' }); },
      (error: unknown) => { setState({ status: 'applied', error: undoErrorText(error, 'event.correct'), final: undoErrorFinal(error) }); },
    );
  };
  const offered = (state.status === 'applied' || state.status === 'undoing') && !state.final;
  return (
    <>
      <Text style={styles.lead}>{correctionDoneLine(card.change)}</Text>
      {state.status === 'undone' ? <View role="status"><Text style={styles.done}>{CORRECTION.undone}</Text></View> : null}
      <Actions>
        {offered ? (
          <Button
            variant="outline"
            label={state.status === 'undoing' ? CORRECTION.undoing : CORRECTION.undo}
            disabled={props.readOnlyId !== null || state.status === 'undoing'}
            {...described(props.readOnlyId)}
            onPress={undo}
          />
        ) : null}
        <LinkButton variant="link" href={calendarHref(props.locationId)} label={CORRECTION.open} />
      </Actions>
      {state.error === null ? null : <ErrorNotice message={state.error} />}
    </>
  );
}

function ProposedBody(props: { card: Extract<Card, { kind: 'proposed' }>; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { api } = usePortal();
  const { card } = props;
  const [state, setState] = useState<ApplyState>({ status: 'open', error: null });
  const apply = (): void => {
    if (state.status !== 'open') return;
    setState({ status: 'applying', error: null });
    applyCorrection(api, props.locationId, card, localToday()).then(
      (outcome) => {
        if (outcome === 'applied' || outcome === 'already') setState({ status: 'applied', error: null });
        else if (outcome === 'gone') setState({ status: 'gone', error: APPLY_NOTICES.gone });
        else setState({ status: 'open', error: APPLY_NOTICES.changedSince });
      },
      (error: unknown) => { setState({ status: 'open', error: applyErrorText(error) }); },
    );
  };
  return (
    <>
      <Text style={styles.lead}>{correctionProposedLine(card.change)}</Text>
      {correctionFieldLines(card.fields).map((line) => <Text key={line} style={styles.field}>{line}</Text>)}
      <Small>{CORRECTION.why}</Small>
      {state.status === 'applied' ? (
        <View role="status"><Text style={styles.done}>{CORRECTION.applied}</Text></View>
      ) : null}
      <Actions>
        {state.status === 'open' || state.status === 'applying' ? (
          <Button
            variant="outline"
            label={state.status === 'applying' ? CORRECTION.applying : CORRECTION.apply}
            disabled={props.readOnlyId !== null || state.status === 'applying'}
            {...described(props.readOnlyId)}
            onPress={apply}
          />
        ) : null}
        <LinkButton variant="link" href={calendarHref(props.locationId)} label={CORRECTION.open} />
      </Actions>
      {state.error === null ? null : <ErrorNotice message={state.error} />}
    </>
  );
}

export function CorrectionCard(props: { card: Card; locationId: string; readOnlyId: string | null }): React.JSX.Element {
  const { card } = props;
  return (
    <View style={styles.card} role="group" aria-label={CORRECTION.eyebrow}>
      <Eyebrow>{CORRECTION.eyebrow}</Eyebrow>
      {card.kind === 'applied'
        ? <AppliedBody card={card} locationId={props.locationId} readOnlyId={props.readOnlyId} />
        : <ProposedBody card={card} locationId={props.locationId} readOnlyId={props.readOnlyId} />}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  // Square corners everywhere in the app (spec 15.6), as the other cards in a reply.
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline,
    borderColor: c.border, borderRadius: theme.radius.none,
  },
  lead: { ...theme.type.sub, color: c.white },
  field: { ...theme.type.small, color: c.text2 },
  done: { ...theme.type.sub, color: c.white },
});
