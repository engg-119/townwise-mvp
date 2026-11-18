import { useCallback, useState } from 'react';

import { ApiError, type ApiClient } from '../../api/client';
import type { ScheduleInput } from '../locations/noteRules';
import { alreadyDecidedRule, decideRuleSuggestion, type Rule } from './api';

// Confirm and Dismiss on suggested closure rules (D46), for one screen: P29's group and P25's panel each keep their own.
// One decision at a time. A decision that lands, and a 409 already_decided (a racing Confirm or Edit saved the rule
// first), call `onDecided` with what was saved; a 404 (decided elsewhere, or its dates passed) forgets every decision
// here and calls `onGone`, for the screen to read its list again; any other refusal stays on its card as the error,
// worded by suggestionWords decideErrorLine.

export interface RuleDecision {
  status: 'accepted' | 'dismissed';
  /** The rule Confirm or Edit saved; null when dismissed, or deleted since. */
  rule: Rule | null;
  /** 409 already_decided: another request saved `rule` first. */
  already: boolean;
}

export interface RuleDecisions {
  /** Decided on this screen, by suggestion id. */
  decided: Readonly<Record<string, RuleDecision>>;
  /** The suggestion whose decision is being sent. */
  deciding: string | null;
  /** A refused decision, by suggestion id. */
  errors: Readonly<Record<string, unknown>>;
  /** Confirm (`accept` with no rule), Edit (`accept` with the edited rule) or Dismiss. */
  decide: (suggestionId: string, decision: 'accept' | 'dismiss', rule?: { text: string; schedule: ScheduleInput | null }) => void;
  /** Forgets every decision and error, as the screen reads its list again. */
  reset: () => void;
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key));
}

export function useRuleDecisions(
  api: ApiClient, locationId: string, events: { onDecided?: (suggestionId: string, decision: RuleDecision) => void; onGone: () => void },
): RuleDecisions {
  const [decided, setDecided] = useState<Record<string, RuleDecision>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, unknown>>({});
  const { onDecided, onGone } = events;

  const settle = useCallback((suggestionId: string, decision: RuleDecision) => {
    setDecided((current) => ({ ...current, [suggestionId]: decision }));
    onDecided?.(suggestionId, decision);
  }, [onDecided]);

  const reset = useCallback(() => {
    setDecided({});
    setErrors({});
  }, []);

  const decide = useCallback((suggestionId: string, decision: 'accept' | 'dismiss', rule?: { text: string; schedule: ScheduleInput | null }) => {
    if (deciding !== null) return;
    setDeciding(suggestionId);
    setErrors((current) => without(current, suggestionId));
    decideRuleSuggestion(api, locationId, suggestionId, decision, rule).then(
      (result) => { settle(suggestionId, { status: result.suggestion.status, rule: result.rule, already: false }); },
      (error: unknown) => {
        const stored = alreadyDecidedRule(error);
        if (stored !== null) {
          settle(suggestionId, { status: 'accepted', rule: stored, already: true });
        } else if (error instanceof ApiError && error.kind === 'http' && error.status === 404) {
          reset();
          onGone();
        } else {
          setErrors((current) => ({ ...current, [suggestionId]: error }));
        }
      },
    ).finally(() => { setDeciding(null); });
  }, [api, locationId, deciding, settle, onGone, reset]);

  return { decided, deciding, errors, decide, reset };
}
