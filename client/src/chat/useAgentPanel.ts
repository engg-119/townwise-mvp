import { useCallback, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client';
import { useLoad, type LoadState } from '../portal/hooks';
import type { Note } from '../portal/locations/api';
import { answerQuestion, loadAgentPanel, type AgentPanel, type QuestionAnswer } from './api';

// The side panel's data (spec P25): the questions TownwiseAI has for the person and what it has been
// doing, both read at once from GET .../agent. An answered question stays on the panel with what the answer did
// until the panel is read again; a question the server no longer asks (a 404) reads the panel again.

export interface Answered {
  answer: QuestionAnswer;
  /** The closure note `closed` saved, or null. */
  note: Note | null;
}

export interface AgentPanelState {
  state: LoadState<AgentPanel>;
  reload: () => void;
  answered: Readonly<Record<string, Answered>>;
  /** The question whose answer is being sent. */
  answering: string | null;
  /** A failed answer's words, by question id. */
  errors: Readonly<Record<string, string>>;
  answer: (questionId: string, answer: QuestionAnswer) => void;
}

export function answerErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'note_limit') return 'This location has 1,000 notes. Delete old ones to add more.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t answer questions.';
    if (error.status === 429) return 'You’ve made a lot of changes. Try again later.';
  }
  return 'Couldn’t save your answer. Try again.';
}

/** `onNoteAdded` runs after an answer saves a note, so the page can mark the location's notes count stale. */
export function useAgentPanel(api: ApiClient, locationId: string, onNoteAdded?: () => void): AgentPanelState {
  const { state, reload: read } = useLoad(useCallback(() => loadAgentPanel(api, locationId), [api, locationId]));
  const [answered, setAnswered] = useState<Record<string, Answered>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState<string | null>(null);
  const inflight = useRef(false);

  const reload = useCallback(() => {
    setAnswered({});
    setErrors({});
    read();
  }, [read]);

  function answer(questionId: string, choice: QuestionAnswer): void {
    if (inflight.current || answered[questionId] !== undefined) return;
    inflight.current = true;
    setAnswering(questionId);
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== questionId)));
    answerQuestion(api, locationId, questionId, choice).then(
      (result) => {
        setAnswered((current) => ({ ...current, [questionId]: { answer: result.question.answer, note: result.note } }));
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

  return { state, reload, answered, answering, errors, answer };
}
