import { useCallback, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client';
import { useLoad, type LoadState } from '../portal/hooks';
import type { Note } from '../portal/locations/api';
import { answerQuestion, loadAgentPanel, type AgentPanel, type QuestionAnswer } from './api';

// The side panel's data (spec P25): the questions TownwiseAI has for the person and what it has been
// doing, both read at once from GET .../agent. An answered question stays on the panel with what the answer did
// until the panel is read again; a question the server no longer asks (a 404) reads the panel again. The panel and
// the questions inline on the chat's landing share this state, so an answer in one shows in the other.
//
// Something else… (answer `other`): the person's words go to TownwiseAI as a chat message, and only once that turn is
// saved (the first try, or Try again under its reply in the thread) is the question answered `other`, whose body is
// the answer alone. The words are kept here, in memory, while they are being written and sent, so a card drawn again
// (the sheet opened again, the landing back after a turn taken back) still has them; folding the field keeps them,
// and they are dropped once the question is answered or the field is cancelled, and never stored.
// A card drawn in both places (the column beside the landing) announces what happens only from the copy the person
// last used, so a screen reader hears it once.

export interface Answered {
  answer: QuestionAnswer;
  /** The note the answer saved (a closure note, or a likely-closed question's open-day note), or null. */
  note: Note | null;
}

/** Something else… on one question. */
export interface SomethingElse {
  /** The field is open. */
  open: boolean;
  text: string;
  /** The message is in the chat: only the answer is left to save. */
  sent: boolean;
  /** Why the message wasn't saved, in the chat's own words. */
  error: string | null;
}

/**
 * Sends a message to TownwiseAI. `ended` hears how each try ended (the send, then any Try again under its reply in the
 * thread): null once its turn is saved, else why not.
 */
export type SendToChat = (message: string, ended: (failure: string | null) => void) => void;

/** Where a card is drawn: the panel (column or sheet) or the chat's landing. */
export type QuestionPlace = 'panel' | 'landing';

export interface AgentPanelState {
  state: LoadState<AgentPanel>;
  reload: () => void;
  answered: Readonly<Record<string, Answered>>;
  /** The question whose answer is being sent. */
  answering: string | null;
  /** A failed answer's words, by question id. */
  errors: Readonly<Record<string, string>>;
  answer: (questionId: string, answer: QuestionAnswer, place: QuestionPlace) => void;
  /** Where the person last used each question's card: only that copy announces what happened. */
  actedIn: Readonly<Record<string, QuestionPlace>>;
  /** Something else…, by question id. */
  others: Readonly<Record<string, SomethingElse>>;
  /** The question whose message is going to the chat. */
  telling: string | null;
  openOther: (questionId: string) => void;
  /** Something else… pressed again: folds the field and keeps its words. */
  foldOther: (questionId: string) => void;
  /** Cancel: closes the field and drops its words. */
  closeOther: (questionId: string) => void;
  typeOther: (questionId: string, text: string) => void;
  /** Sends `message` with `send`, then, once its turn is saved, answers `other`. One at a time, as answers are. */
  tell: (questionId: string, message: string, send: SendToChat, place: QuestionPlace) => void;
}

export function answerErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'note_limit') return 'This location has 1,000 notes. Delete old ones to add more.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t answer questions.';
    if (error.status === 429) return 'You’ve made a lot of changes. Try again later.';
  }
  return 'Couldn’t save your answer. Try again.';
}

/** The questions not answered yet; null while they load or when they can't be read. */
export function openQuestions(panel: AgentPanelState): number | null {
  if (panel.state.status !== 'ready') return null;
  return panel.state.data.questions.filter((question) => panel.answered[question.id] === undefined).length;
}

const CLOSED: SomethingElse = { open: false, text: '', sent: false, error: null };

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

/** `onNoteAdded` runs after an answer saves a note, so the page can mark the location's notes count stale. */
export function useAgentPanel(api: ApiClient, locationId: string, onNoteAdded?: () => void): AgentPanelState {
  const { state, reload: read } = useLoad(useCallback(() => loadAgentPanel(api, locationId), [api, locationId]));
  const [answered, setAnswered] = useState<Record<string, Answered>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<string | null>(null);
  const [others, setOthers] = useState<Record<string, SomethingElse>>({});
  const [telling, setTelling] = useState<string | null>(null);
  const [actedIn, setActedIn] = useState<Record<string, QuestionPlace>>({});
  const inflight = useRef(false);

  const reload = useCallback(() => {
    setAnswered({});
    setErrors({});
    read();
  }, [read]);

  function patchOther(questionId: string, patch: Partial<SomethingElse>): void {
    setOthers((current) => ({ ...current, [questionId]: { ...(current[questionId] ?? CLOSED), ...patch } }));
  }

  function usedIn(questionId: string, place: QuestionPlace): void {
    setActedIn((current) => (current[questionId] === place ? current : { ...current, [questionId]: place }));
  }

  function answer(questionId: string, choice: QuestionAnswer, place: QuestionPlace): void {
    if (inflight.current || answered[questionId] !== undefined) return;
    inflight.current = true;
    usedIn(questionId, place);
    setAnswering(questionId);
    setErrors((current) => without(current, questionId));
    answerQuestion(api, locationId, questionId, choice).then(
      (result) => {
        setAnswered((current) => ({ ...current, [questionId]: { answer: result.question.answer, note: result.note } }));
        // Whatever was typed for Something else… goes with the question.
        setOthers((current) => without(current, questionId));
        if (result.note !== null) onNoteAdded?.();
      },
      (error: unknown) => {
        // The question changed or went (new sales, a note): read the panel again.
        if (error instanceof ApiError && error.kind === 'http' && error.status === 404) {
          reload();
          return;
        }
        setErrors((current) => ({ ...current, [questionId]: answerErrorText(error) }));
      },
    ).finally(() => {
      inflight.current = false;
      setAnswering(null);
    });
  }

  function tell(questionId: string, message: string, send: SendToChat, place: QuestionPlace): void {
    if (inflight.current || answered[questionId] !== undefined) return;
    // No answer starts while the message goes, so the answer that follows it is never turned away as a second one.
    inflight.current = true;
    usedIn(questionId, place);
    setTelling(questionId);
    patchOther(questionId, { error: null });
    setErrors((current) => without(current, questionId));
    let first = true;
    send(message, (failure) => {
      if (first) {
        first = false;
        inflight.current = false;
        setTelling(null);
      }
      if (failure !== null) {
        patchOther(questionId, { error: failure });
        return;
      }
      patchOther(questionId, { sent: true, error: null });
      // A Try again in the thread ended while another answer was going: the card offers Try again for this one.
      if (inflight.current) setErrors((current) => ({ ...current, [questionId]: answerErrorText(null) }));
      else answer(questionId, 'other', place);
    });
  }

  return {
    state, reload, answered, answering, errors, answer, actedIn, others, telling, tell,
    openOther: (questionId) => { patchOther(questionId, { open: true }); },
    foldOther: (questionId) => { patchOther(questionId, { open: false }); },
    closeOther: (questionId) => { setOthers((current) => without(current, questionId)); },
    typeOther: (questionId, text) => { patchOther(questionId, { text }); },
  };
}
