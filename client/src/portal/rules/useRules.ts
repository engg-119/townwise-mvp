import { useCallback, useState } from 'react';

import type { ApiClient } from '../../api/client';
import { useLoad, type LoadState } from '../hooks';
import { createRule, deleteRule, fetchRules, updateRule, type Rule, type RulesList, type RuleWrite } from './api';

// A location's business rules for one screen (the Business rules page; the TownwiseAI side panel later): the list
// as loaded, with this screen's own adds, edits and deletes applied in place, so a write needs no reload. Each write
// throws what the API answered, for the caller to show where it happened. D46: the list's suggested rules too, and
// `settle`, which takes a decided suggestion out of them and puts the rule it saved, if any, at the end of the list.

export interface Rules {
  state: LoadState<RulesList>;
  reload: () => void;
  add: (write: RuleWrite) => Promise<Rule>;
  edit: (ruleId: string, write: RuleWrite) => Promise<Rule>;
  remove: (ruleId: string) => Promise<void>;
  /** A suggested rule decided: out of `suggested`, and its saved rule (Confirm or Edit) into the list unless it is there. */
  settle: (suggestionId: string, rule: Rule | null) => void;
}

export function useRules(api: ApiClient, locationId: string): Rules {
  const { state: loadState, reload } = useLoad(useCallback(() => fetchRules(api, locationId), [api, locationId]));
  const loaded = loadState.status === 'ready' ? loadState.data : null;
  const [local, setLocal] = useState<{ from: RulesList; list: RulesList } | null>(null);
  const state: LoadState<RulesList> = loaded !== null && local?.from === loaded ? { status: 'ready', data: local.list } : loadState;

  const changeList = useCallback((update: (list: RulesList) => RulesList) => {
    if (loaded === null) return;
    setLocal((previous) => {
      const current = previous?.from === loaded ? previous.list : loaded;
      return { from: loaded, list: update(current) };
    });
  }, [loaded]);
  const change = useCallback((update: (rules: Rule[]) => Rule[]) => {
    changeList((current) => ({ ...current, rules: update(current.rules) }));
  }, [changeList]);

  const add = useCallback(async (write: RuleWrite) => {
    const rule = await createRule(api, locationId, write);
    change((rules) => [...rules, rule]);
    return rule;
  }, [api, locationId, change]);

  const edit = useCallback(async (ruleId: string, write: RuleWrite) => {
    const rule = await updateRule(api, locationId, ruleId, write);
    change((rules) => rules.map((other) => (other.id === rule.id ? rule : other)));
    return rule;
  }, [api, locationId, change]);

  const remove = useCallback(async (ruleId: string) => {
    await deleteRule(api, locationId, ruleId);
    change((rules) => rules.filter((other) => other.id !== ruleId));
  }, [api, locationId, change]);

  const settle = useCallback((suggestionId: string, rule: Rule | null) => {
    changeList((current) => ({
      ...current,
      suggested: current.suggested.filter((suggestion) => suggestion.id !== suggestionId),
      rules: rule === null || current.rules.some((other) => other.id === rule.id) ? current.rules : [...current.rules, rule],
    }));
  }, [changeList]);

  return { state, reload, add, edit, remove, settle };
}
