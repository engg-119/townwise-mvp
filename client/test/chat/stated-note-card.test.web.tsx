import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { ProposalActions } from '../../src/chat/ui/ProposalCard';
import { ProposalCard } from '../../src/chat/ui/ProposalCard';
import type { ProposalCard as Card } from '../../src/chat/useTuningChat';
import { PROPOSAL, PROPOSAL_ID } from '../helpers/chat';

// D59 slice 4: a note TownwiseAI saved itself from the person's message. Its card says so, offers Undo while the person
// may undo it, and says what became of it once undone or changed since; it never offers Save note.

afterEach(cleanup);

function actions(): ProposalActions {
  return {
    save: jest.fn(), saveEdited: jest.fn(() => Promise.resolve()), edit: jest.fn(), cancelEdit: jest.fn(), dismiss: jest.fn(), reopen: jest.fn(),
    undo: jest.fn(),
  };
}

function card(auto: NonNullable<Card['auto']>, over: Partial<Card> = {}): Card {
  return { id: PROPOSAL_ID, proposal: PROPOSAL, status: 'saved', stored: 'kept', edited: false, gone: false, error: null, auto, ...over };
}

test('saved from the person’s message: says so, links Notes, and Undo sends the card’s undo', () => {
  const act = actions();
  render(<ProposalCard card={card({ changeId: 'ch1', status: 'applied', undoable: true })} locationId="l1" actions={act} readOnlyId={null} />);
  expect(screen.getByText('Note from your message')).toBeTruthy();
  expect(screen.queryByText('Proposed note')).toBeNull();
  expect(screen.getByText('TownwiseAI saved this to Notes, as you said it.')).toBeTruthy();
  expect(screen.getByText('Open Notes')).toBeTruthy();
  expect(screen.queryByText('Save note')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(act.undo).toHaveBeenCalledWith(PROPOSAL_ID);
});

test('while an undo is sent its button waits; a caller who may not undo sees none', () => {
  const view = render(<ProposalCard card={card({ changeId: 'ch1', status: 'undoing', undoable: true })} locationId="l1" actions={actions()} readOnlyId={null} />);
  expect(screen.getByRole('button', { name: 'Undoing…' }).getAttribute('aria-disabled')).toBe('true');
  view.rerender(<ProposalCard card={card({ changeId: 'ch1', status: 'applied', undoable: false })} locationId="l1" actions={actions()} readOnlyId={null} />);
  expect(screen.queryByText('Undo')).toBeNull();
});

test('undone, or changed since: says what became of it, with no Undo', () => {
  const view = render(<ProposalCard card={card({ changeId: 'ch1', status: 'undone', undoable: false })} locationId="l1" actions={actions()} readOnlyId={null} />);
  expect(screen.getByText('Undone. TownwiseAI took this note back out of Notes.')).toBeTruthy();
  expect(screen.queryByText('Undo')).toBeNull();
  expect(screen.queryByText('Open Notes')).toBeNull();
  view.rerender(<ProposalCard card={card({ changeId: 'ch1', status: 'adopted', undoable: false }, { error: 'You changed this since, so it’s yours now. Delete it from Notes if you don’t want it.' })} locationId="l1" actions={actions()} readOnlyId={null} />);
  expect(screen.getByText('Saved to Notes. You changed it since, so it’s yours.')).toBeTruthy();
  expect(screen.getByText('You changed this since, so it’s yours now. Delete it from Notes if you don’t want it.')).toBeTruthy();
  expect(screen.queryByText('Undo')).toBeNull();
});
