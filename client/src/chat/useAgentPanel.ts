import { useCallback, useRef, useState } from 'react';

import { ApiError, type ApiClient } from '../api/client';
import { useLoad, type LoadState } from '../portal/hooks';
import type { Note } from '../portal/locations/api';
import type { Rule } from '../portal/rules/api';
import { useRuleDecisions, type RuleDecisions } from '../portal/rules/useRuleDecisions';
import {
  answerQuestion, decideSuggestion, loadAgentPanel, setCalendarTitles, setWeeklySuggestions, type AgentPanel, type EventChoice, type QuestionAnswer,
} from './api';
import { suggestionDaysText } from './format';

// The side panel's data (spec P25): the questions TownwiseAI has for the person and what it has been
// doing, both read at once from GET .../agent. An answered question stays on the panel with what the answer did
// until the panel is read again; a question the server no longer asks (a 404) reads the panel again. The panel and
// the questions inline on the chat's landing share this state, so an answer in one shows in the other.
//
// Something else… (answer `other`): the person's words go to TownwiseAI as a chat message, and only once that turn is
// saved (the first try, or Try again under its reply in the thread) is the question answered `other`, whose body is
// the answer alone. The words are kept here, in memory, while they are being written and sent, so a card drawn again
// (the new chat page shown again, the landing back after a turn taken back) still has them; folding the field keeps them,
// and they are dropped once the question is answered or the field is canceled, and never stored.
// A card drawn in both places (the column beside the landing) announces what happens only from the copy the person
// last used, so a screen reader hears it once.
//
// Weekly suggestions (openspec change weekly-forecast-suggestions): an org admin accepts or dismisses each one, one at
// a time; a decided suggestion stays on the panel with what it did until the panel is read again, and one the server no
// longer has open (a 404: dismissed or decided elsewhere, or its date has come) reads the panel again. The switch keeps
// what the person last set here over what was read.
//
// The location's calendars (openspec change calendar-event-suggestions): a spotted event's accept carries the admin's
// choice, which is held here with its guest count, by suggestion id, so a re-read of the panel (which draws the cards
// again) keeps them; they go once the suggestion is decided or no longer listed. A follow-up whose note was edited since
// it was made (409 note_changed) stays open: the panel reads again and the card says why nothing changed. A spotted
// event that moved or went (409 event_changed) is gone: the panel reads again and the section's notice says, by its
// days, never its title, why its card went. The titles switch keeps what was last set here, as the
// weekly switch does. A removal's accept deletes a note, so it marks the notes stale as a saved note does.
//
// Suggested closure rules (D46): any member confirms or dismisses one here (`rules`, portal/rules/useRuleDecisions.ts),
// Edit being P29's form; a decided one stays with what it did until the panel is read again, and a 404 reads it again.

export interface Answered {
  answer: QuestionAnswer;
  /**
   * The note the answer saved (a closure note, or a likely-closed question's open-day note), or (D71) the private event's
   * note its count was saved into; or null.
   */
  note: Note | null;
}

/** What an org admin's decision on a suggestion did. */
export interface Decided {
  status: 'accepted' | 'dismissed';
  /** The note or rule an accepted suggestion wrote, or null. */
  note: Note | null;
  rule: Rule | null;
}

/** A spotted event's choice and guest count as the admin left them on its card. */
export interface EventDraft {
  effect: EventChoice['effect'] | null;
  guests: string;
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

/** Where a card is drawn: the panel (column or phone row) or the chat's landing. */
export type QuestionPlace = 'panel' | 'landing';

export interface AgentPanelState {
  state: LoadState<AgentPanel>;
  reload: () => void;
  answered: Readonly<Record<string, Answered>>;
  /** The question whose answer is being sent. */
  answering: string | null;
  /** A failed answer's words, by question id. */
  errors: Readonly<Record<string, string>>;
  /** `guests`: a private event's count (D71), with the answer `guests`. */
  answer: (questionId: string, answer: QuestionAnswer, place: QuestionPlace, guests?: number) => void;
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
  /** Weekly suggestions decided here, by suggestion id. */
  decided: Readonly<Record<string, Decided>>;
  /** The suggestion whose decision is being sent. */
  deciding: string | null;
  /** A failed decision's words, by suggestion id. */
  suggestionErrors: Readonly<Record<string, string>>;
  /** `choice` on a spotted event's accept only. */
  decide: (suggestionId: string, decision: 'accept' | 'dismiss', choice?: EventChoice) => void;
  /** Spotted events' choices and counts, by suggestion id: only those still listed and not decided. */
  eventDrafts: Readonly<Record<string, EventDraft>>;
  setEventDraft: (suggestionId: string, draft: EventDraft) => void;
  /** Why a card the person decided on went instead (its event changed), until the panel is read again or another decision. */
  suggestionsNotice: string | null;
  /** The organization's weekly suggestions switch as last set here; null when it was not set here since the read. */
  weeklyOn: boolean | null;
  switching: boolean;
  switchError: string | null;
  /** Turns weekly suggestions on or off (`orgId` from openAsAdminOrgId). */
  setWeekly: (on: boolean, orgId: string | null) => void;
  /** The calendar titles switch as last set here; null when it was not set here since the read. */
  titlesOn: boolean | null;
  switchingTitles: boolean;
  titlesError: string | null;
  /** Turns reading the calendars' event titles on or off (`orgId` from openAsAdminOrgId). */
  setTitles: (on: boolean, orgId: string | null) => void;
  /** D46: Confirm and Dismiss on the suggested closure rules. */
  rules: RuleDecisions;
}

export function answerErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'note_limit') return 'This location has 1,000 notes. Delete old ones to add more.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t answer questions.';
    if (error.status === 429) return 'You’ve made a lot of changes. Try again later.';
  }
  return 'Couldn’t save your answer. Try again.';
}

export function decideErrorText(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.code === 'note_limit') return 'This location has 1,000 notes. Delete old ones to add more.';
    if (error.code === 'rule_limit') return 'This location has 30 business rules. Delete one to add this.';
    if (error.code === 'rule_exists') return 'That rule is already saved.';
    if (error.code === 'note_changed') return 'Someone changed this note since, so nothing was changed. Check the note, or wait for your calendar’s next refresh. Dismiss keeps the note as it is.';
    if (error.code === 'invalid_request') return 'Enter the guests to accept it alongside regular service.';
    if (error.code === 'view_as_read_only') return 'View-as is read-only, so you can’t accept or dismiss suggestions.';
    if (error.status === 429) return 'You’ve made a lot of changes. Try again later.';
  }
  return 'Couldn’t save that. Try again.';
}

/** The weekly suggestions not decided yet; null while they load or when they can't be read. */
export function openSuggestions(panel: AgentPanelState): number | null {
  if (panel.state.status !== 'ready') return null;
  return panel.state.data.suggestions.filter((suggestion) => panel.decided[suggestion.id] === undefined).length;
}

/** The suggested closure rules not decided yet (D46); null while they load or when they can't be read. */
export function openRuleSuggestions(panel: AgentPanelState): number | null {
  if (panel.state.status !== 'ready') return null;
  return panel.state.data.ruleSuggestions.filter((suggestion) => panel.rules.decided[suggestion.id] === undefined).length;
}

/** The questions not answered yet; null while they load or when they can't be read. */
export function openQuestions(panel: AgentPanelState): number | null {
  if (panel.state.status !== 'ready') return null;
  return panel.state.data.questions.filter((question) => panel.answered[question.id] === undefined).length;
}

/**
 * What the panel asks the person to decide: its open questions, open weekly suggestions and (D46) open suggested rules,
 * as Home's link counts them ("{n} questions from TownwiseAI"); null while they load or when they can't be read.
 */
export function openToDecide(panel: AgentPanelState): number | null {
  const questions = openQuestions(panel);
  return questions === null ? null : questions + (openSuggestions(panel) ?? 0) + (openRuleSuggestions(panel) ?? 0);
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
  const [decided, setDecided] = useState<Record<string, Decided>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
  const [suggestionErrors, setSuggestionErrors] = useState<Record<string, string>>({});
  const [weeklyOn, setWeeklyOn] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [suggestionsNotice, setSuggestionsNotice] = useState<string | null>(null);
  const [titlesOn, setTitlesOn] = useState<boolean | null>(null);
  const [switchingTitles, setSwitchingTitles] = useState(false);
  const [titlesError, setTitlesError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EventDraft>>({});
  // A suggestion no longer listed takes its draft with it (kept while the panel reads again).
  const listed = state.status === 'ready' ? new Set(state.data.suggestions.map((each) => each.id)) : null;
  const eventDrafts = listed === null ? drafts : Object.fromEntries(Object.entries(drafts).filter(([id]) => listed.has(id)));

  function setEventDraft(suggestionId: string, draft: EventDraft): void {
    setDrafts((current) => ({ ...(listed === null ? current : Object.fromEntries(Object.entries(current).filter(([id]) => listed.has(id)))), [suggestionId]: draft }));
  }

  /** Reads the panel again, from scratch but the suggested rules' decisions, which the caller clears. */
  const readAgain = useCallback(() => {
    setAnswered({});
    setErrors({});
    setDecided({});
    setSuggestionErrors({});
    setSuggestionsNotice(null);
    setWeeklyOn(null);
    setTitlesOn(null);
    read();
  }, [read]);
  // A suggested rule gone from under a decision (404) clears the rules' own decisions, then reads the panel again.
  const rules = useRuleDecisions(api, locationId, { onGone: readAgain });
  const { reset: resetRules } = rules;
  const reload = useCallback(() => {
    resetRules();
    readAgain();
  }, [resetRules, readAgain]);

  function decide(suggestionId: string, decision: 'accept' | 'dismiss', choice?: EventChoice): void {
    if (deciding !== null || decided[suggestionId] !== undefined) return;
    const suggestion = state.status === 'ready' ? state.data.suggestions.find((each) => each.id === suggestionId) : undefined;
    const removal = suggestion?.type === 'remove';
    setDeciding(suggestionId);
    setSuggestionsNotice(null);
    setSuggestionErrors((current) => without(current, suggestionId));
    decideSuggestion(api, locationId, suggestionId, decision, choice ?? null).then(
      (result) => {
        setDecided((current) => ({ ...current, [suggestionId]: { status: result.suggestion.status, note: result.note, rule: result.rule } }));
        setDrafts((current) => without(current, suggestionId));
        if (result.note !== null || (removal && result.suggestion.status === 'accepted')) onNoteAdded?.();
      },
      (error: unknown) => {
        const code = error instanceof ApiError && error.kind === 'http' ? error.code : null;
        if (error instanceof ApiError && error.kind === 'http' && error.status === 404) {
          reload();
          return;
        }
        if (code === 'event_changed') {
          reload();
          const days = suggestion === undefined || suggestion.type === 'rule' ? null
            : suggestionDaysText(suggestion.note.startDate, suggestion.note.endDate, suggestion.note.weekdays);
          setSuggestionsNotice(`${days === null ? 'That event' : `The event on ${days}`} moved or is no longer on your calendar, so nothing was saved.`);
          return;
        }
        setSuggestionErrors((current) => ({ ...current, [suggestionId]: decideErrorText(error) }));
        // The note changed: read the panel again for the note as it is now, keeping the card's word on why.
        if (code === 'note_changed') read();
      },
    ).finally(() => { setDeciding(null); });
  }

  function setTitles(on: boolean, orgId: string | null): void {
    if (switchingTitles) return;
    setSwitchingTitles(true);
    setTitlesError(null);
    setCalendarTitles(api, on, orgId).then(
      (now) => { setTitlesOn(now); },
      (error: unknown) => {
        const code = error instanceof ApiError && error.kind === 'http' ? error.code : null;
        setTitlesError(code === 'view_as_read_only' ? 'View-as is read-only, so you can’t change this.'
          : code === 'open_as_admin_refused' ? 'Only an admin of this organization can turn this on. You can turn it off.'
            : 'Couldn’t change reading event titles. Try again.');
      },
    ).finally(() => { setSwitchingTitles(false); });
  }

  function setWeekly(on: boolean, orgId: string | null): void {
    if (switching) return;
    setSwitching(true);
    setSwitchError(null);
    setWeeklySuggestions(api, on, orgId).then(
      (now) => { setWeeklyOn(now); },
      (error: unknown) => {
        setSwitchError(error instanceof ApiError && error.kind === 'http' && error.code === 'view_as_read_only'
          ? 'View-as is read-only, so you can’t change this.'
          : 'Couldn’t change weekly suggestions. Try again.');
      },
    ).finally(() => { setSwitching(false); });
  }

  function patchOther(questionId: string, patch: Partial<SomethingElse>): void {
    setOthers((current) => ({ ...current, [questionId]: { ...(current[questionId] ?? CLOSED), ...patch } }));
  }

  function usedIn(questionId: string, place: QuestionPlace): void {
    setActedIn((current) => (current[questionId] === place ? current : { ...current, [questionId]: place }));
  }

  function answer(questionId: string, choice: QuestionAnswer, place: QuestionPlace, guests?: number): void {
    if (inflight.current || answered[questionId] !== undefined) return;
    inflight.current = true;
    usedIn(questionId, place);
    setAnswering(questionId);
    setErrors((current) => without(current, questionId));
    answerQuestion(api, locationId, questionId, choice, guests).then(
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
    decided, deciding, suggestionErrors, decide, eventDrafts, setEventDraft, suggestionsNotice, weeklyOn, switching, switchError, setWeekly,
    titlesOn, switchingTitles, titlesError, setTitles, rules,
    openOther: (questionId) => { patchOther(questionId, { open: true }); },
    foldOther: (questionId) => { patchOther(questionId, { open: false }); },
    closeOther: (questionId) => { setOthers((current) => without(current, questionId)); },
    typeOther: (questionId, text) => { patchOther(questionId, { text }); },
  };
}
