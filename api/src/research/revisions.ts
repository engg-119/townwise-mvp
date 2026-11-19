// The fold of a location's hand edits of one researched event (D66, design decision 11): what the event looks like at
// that location after its revisions. Pure: research/read.ts reads the rows and the revisions and calls `foldRevisions`.
//
// Revisions are append-only and form one chain per event and location: the revision based on `'base'` first, then each
// revision's single child (the unique `(orgId, locationId, eventId, basedOn)` index allows one child of each). The head
// is the chain's last revision, and the `basedOn` the next edit must send. A revision whose `basedOn` names no
// revision in the chain is ignored with its descendants (revisions are never deleted one by one, so that happens only
// after a place or town change's cleanup). `edit` sets its fields over the state before it, `hide` hides, `restore`
// returns research's own values, shown, and `revert` returns the state before the revision it reverts (TownwiseAI's
// Undo). A merge changes only the base, so an edit or a hide outlives research finding the event again.
//
// This file and read.ts are the only ones under research/ that touch the edits (test/isolation.test.ts): a member's
// typed title or `where` never reaches a prompt.
import type { RevisionFields, RevisionRecord } from '../stores/research-revisions.ts';

/** The values a revision can change, as research found them or as edited. */
export interface EditableValues {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly weekdays: readonly number[] | null;
  readonly startTime: string | null;
  readonly where: string | null;
}

export interface FoldedEvent {
  /** `'base'`, or the id of the chain's last revision: the `basedOn` the next revision sends. */
  readonly head: string;
  readonly values: EditableValues;
  readonly hidden: boolean;
  /** Whether the shown values differ from research's own (the Calendar's "Edited by your team · Reset"). */
  readonly edited: boolean;
}

interface State { readonly values: EditableValues; readonly hidden: boolean }

function applyFields(values: EditableValues, fields: RevisionFields | null): EditableValues {
  if (fields === null) return values;
  return {
    title: fields.title ?? values.title,
    start: fields.start ?? values.start,
    end: fields.end ?? values.end,
    weekdays: fields.weekdays !== undefined ? fields.weekdays : values.weekdays,
    startTime: fields.startTime !== undefined ? fields.startTime : values.startTime,
    where: fields.where !== undefined ? fields.where : values.where,
  };
}

function sameValues(a: EditableValues, b: EditableValues): boolean {
  const days = (list: readonly number[] | null) => (list === null ? null : list.join(','));
  return a.title === b.title && a.start === b.start && a.end === b.end && days(a.weekdays) === days(b.weekdays)
    && a.startTime === b.startTime && a.where === b.where;
}

/**
 * The chain of one event's revisions from `'base'`, in order. `revisions` may hold other events' revisions and orphans;
 * both are left out.
 */
export function chainOf(eventId: string, revisions: readonly RevisionRecord[]): RevisionRecord[] {
  const childOf = new Map<string, RevisionRecord>();
  for (const revision of revisions) {
    // The unique index allows one child of each; the first stored wins should two ever be read.
    if (revision.eventId === eventId && !childOf.has(revision.basedOn)) childOf.set(revision.basedOn, revision);
  }
  const chain: RevisionRecord[] = [];
  let next = childOf.get('base');
  while (next !== undefined && chain.length <= revisions.length) {
    chain.push(next);
    next = childOf.get(next.id);
  }
  return chain;
}

/** One event at one location after its revisions; `revisions` may hold other events' too. */
export function foldRevisions(eventId: string, base: EditableValues, revisions: readonly RevisionRecord[]): FoldedEvent {
  const chain = chainOf(eventId, revisions);
  // states[i] is the state before chain[i]; states[chain.length] the effective one.
  const states: State[] = [{ values: base, hidden: false }];
  for (const revision of chain) {
    const before = states[states.length - 1] ?? { values: base, hidden: false };
    let after: State;
    switch (revision.op) {
      case 'edit': after = { values: applyFields(before.values, revision.fields), hidden: before.hidden }; break;
      case 'hide': after = { values: before.values, hidden: true }; break;
      case 'restore': after = { values: base, hidden: false }; break;
      case 'revert': {
        const index = revision.reverts === null ? -1 : chain.findIndex((each) => each.id === revision.reverts);
        // A revert names a revision earlier in its own chain; anything else changes nothing.
        after = index >= 0 && index < states.length - 1 ? states[index] ?? before : before;
        break;
      }
    }
    states.push(after);
  }
  const effective = states[states.length - 1] ?? { values: base, hidden: false };
  return {
    head: chain.at(-1)?.id ?? 'base',
    values: effective.values,
    hidden: effective.hidden,
    edited: !sameValues(effective.values, base),
  };
}
