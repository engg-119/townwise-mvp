import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { errorCopy, hasCode } from '../errors';
import { formatDate } from '../format';
import { useAction } from '../hooks';
import { LoadFailure, Loading } from '../locations/parts';
import { shownLocationName } from '../locations/naming';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, ErrorNotice, Notice, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Columns, Section, Stack } from '../ui/layout';
import { Body, Small } from '../ui/text';
import type { Rule } from './api';
import { counterLine, normalizeRule, RULES_COPY, ruleProblem } from './rules';
import { useRules } from './useRules';

// P28 Business rules (spec 16.3, 10.16, D31; /locations/[id]/rules, members): standing facts about how the location
// runs, which TownwiseAI reads with every message the person sends. They never change Townwise's forecast; notes do,
// and the lead says which. The page lives under TownwiseAI in the top bar. “New rule” and the page's one primary,
// “Add rule”, add a rule (Enter submits on web); at the limit both are disabled, described by the limit line. Each
// rule shows who added it and how; its author or an org admin edits it in place or deletes it after a confirm.
// Errors show where the write happened: on the add form, the row's edit or the dialog. A 404 on an edit or a delete
// means the rule went in the meantime: the page says so and the list loads again. A 403 forbidden (an org admin made
// a member since the list loaded) shows its line and re-reads the person's access, as every access error does (4.3). Under view-as every write control is
// disabled in place, described by the read-only line. TownwiseAI's rule proposals come later; nothing here says it
// suggests rules yet.

const READ_ONLY_ID = 'rules-ro';
const LIMIT_ID = 'rules-limit';
/** The API's word for an author whose account is gone (api/src/people.ts DELETED_PERSON). */
const DELETED_PERSON = 'Deleted person';

/** “Added by owner@example.com, Mar 2, 2026”, or “Saved from TownwiseAI by …” for a rule saved from a chat card. */
function addedLine(rule: Rule): string {
  const who = rule.createdByEmail === DELETED_PERSON ? 'a deleted person' : rule.createdByEmail;
  return `${rule.addedVia === 'townwise_ai' ? 'Saved from TownwiseAI by' : 'Added by'} ${who}, ${formatDate(rule.createdAt)}`;
}

/** A refused write in the page's words; `text` is what was sent, for a 400 the page's own check missed. */
function writeError(error: unknown, text: string): string {
  if (hasCode(error, 409, 'rule_exists')) return RULES_COPY.exists;
  if (hasCode(error, 409, 'rule_limit')) return RULES_COPY.limit;
  if (hasCode(error, 403, 'forbidden')) return RULES_COPY.forbidden;
  if (hasCode(error, 400, 'invalid_request')) return ruleProblem(text) ?? errorCopy(error);
  return errorCopy(error);
}

/** A rule's one-line field with its helper and, near the limit, its character count. */
function RuleField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  message: string | null;
  readOnlyId: string | null;
}): React.JSX.Element {
  const counter = counterLine(props.value);
  return (
    <Stack gap={8}>
      <FormField
        label={props.label}
        helper={RULES_COPY.helper}
        placeholder="Closed Mondays"
        value={props.value}
        onChangeText={props.onChange}
        onSubmitEditing={props.onSubmit}
        autoCapitalize="sentences"
        returnKeyType="done"
        messages={props.message === null ? [] : [props.message]}
        {...(props.readOnlyId === null ? {} : { readOnly: true, readOnlyId: props.readOnlyId })}
      />
      {counter === null ? null : <Small>{counter}</Small>}
    </Stack>
  );
}

/** “New rule” and “Add rule”. Text the API refused stays in the field, with why. */
function AddRule(props: {
  atLimit: boolean;
  readOnlyId: string | null;
  add: (text: string) => Promise<Rule>;
  onAdded: () => void;
  onGone: () => void;
}): React.JSX.Element {
  const { add, onAdded, onGone } = props;
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const action = useAction(useCallback(async (sent: string) => {
    try {
      await add(sent);
    } catch (error) {
      // A new rule can only miss its location, which the list's reload reports.
      if (hasCode(error, 404, 'not_found')) { onGone(); return; }
      throw error;
    }
    setText('');
    onAdded();
  }, [add, onAdded, onGone]));
  const blockedBy = props.readOnlyId ?? (props.atLimit ? LIMIT_ID : null);

  function submit(): void {
    if (blockedBy !== null || action.pending) return;
    const found = ruleProblem(text);
    setProblem(found);
    if (found === null) action.run(normalizeRule(text));
  }

  return (
    <Stack>
      <RuleField label="New rule" value={text} onChange={setText} onSubmit={submit} message={problem} readOnlyId={blockedBy} />
      {props.atLimit ? <Small nativeID={LIMIT_ID}>{RULES_COPY.limit}</Small> : null}
      {action.error === null ? null : <ErrorNotice message={writeError(action.error, text)} />}
      <Actions>
        <Button
          label={action.pending ? 'Adding…' : 'Add rule'}
          disabled={blockedBy !== null || action.pending}
          {...(blockedBy === null ? {} : { describedBy: blockedBy })}
          onPress={submit}
        />
      </Actions>
    </Stack>
  );
}

/** A row in edit: the field with the rule's text, Save and Cancel. */
function EditRule(props: {
  rule: Rule;
  edit: (ruleId: string, text: string) => Promise<Rule>;
  onSaved: () => void;
  onCancel: () => void;
  onRefused: (error: unknown) => boolean;
}): React.JSX.Element {
  const { rule, edit, onSaved, onRefused } = props;
  const [text, setText] = useState(rule.text);
  const [problem, setProblem] = useState<string | null>(null);
  const action = useAction(useCallback(async (sent: string) => {
    try {
      await edit(rule.id, sent);
    } catch (error) {
      if (onRefused(error)) return;
      throw error;
    }
    onSaved();
  }, [edit, rule.id, onSaved, onRefused]));

  function submit(): void {
    if (action.pending) return;
    const found = ruleProblem(text);
    setProblem(found);
    if (found === null) action.run(normalizeRule(text));
  }

  return (
    <Stack>
      <RuleField label="Edit rule" value={text} onChange={setText} onSubmit={submit} message={problem} readOnlyId={null} />
      {action.error === null ? null : <ErrorNotice message={writeError(action.error, text)} />}
      <Actions>
        <Button variant="outline" label={action.pending ? 'Saving…' : 'Save'} disabled={action.pending} onPress={submit} />
        <Button variant="link" label="Cancel" onPress={props.onCancel} />
      </Actions>
    </Stack>
  );
}

export function BusinessRules(): React.JSX.Element {
  const { location, org } = useLocation();
  const shown = shownLocationName(location, org);
  const { api } = usePortal();
  const { readOnly, line } = useReadOnly();
  const readOnlyId = readOnly ? READ_ONLY_ID : null;
  const rules = useRules(api, location.id);
  const { reload, remove: removeRule } = rules;
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);

  const gone = useCallback((text: string | null) => {
    setEditingId(null);
    setDeleting(null);
    setNotice(text);
    reload();
  }, [reload]);

  /** A rule that went in the meantime (404) closes its edit or the dialog, says so and loads the list again. */
  const ruleGone = useCallback((error: unknown): boolean => {
    if (!hasCode(error, 404, 'not_found')) return false;
    gone(RULES_COPY.gone);
    return true;
  }, [gone]);

  const remove = useAction(useCallback(async (rule: Rule) => {
    try {
      await removeRule(rule.id);
    } catch (error) {
      if (ruleGone(error)) return;
      throw error;
    }
    setDeleting(null);
    if (editingId === rule.id) setEditingId(null);
    setNotice('Deleted the rule.');
  }, [removeRule, ruleGone, editingId]));

  const { state } = rules;
  let content: React.ReactNode;
  if (state.status === 'loading') content = <Loading text="Loading business rules" minHeight={240} />;
  else if (state.status === 'failed') content = <LoadFailure error={state.error} onRetry={reload} />;
  else {
    const { rules: list, limit } = state.data;
    content = (
      <Stack gap={32}>
        <Columns
          main={(
            <AddRule
              atLimit={list.length >= limit}
              readOnlyId={readOnlyId}
              add={rules.add}
              onAdded={() => { setNotice('Added the rule.'); }}
              onGone={() => { gone(null); }}
            />
          )}
        />
        <Section first kicker={`${String(list.length)} of ${String(limit)}`} title="Rules">
          {list.length === 0 ? <EmptyState text="No business rules yet. Add one above." /> : (
            <View role="list" aria-label="Business rules" style={styles.list}>
              {list.map((rule) => (
                <View key={rule.id} role="listitem" style={styles.row}>
                  {editingId === rule.id ? (
                    <EditRule
                      rule={rule}
                      edit={rules.edit}
                      onSaved={() => { setEditingId(null); setNotice('Saved.'); }}
                      onCancel={() => { setEditingId(null); }}
                      onRefused={ruleGone}
                    />
                  ) : (
                    <>
                      <Text style={styles.text}>{rule.text}</Text>
                      <Small>{addedLine(rule)}</Small>
                      {rule.canEdit ? (
                        <Actions>
                          <Button
                            variant="link"
                            label="Edit"
                            accessibilityLabel={`Edit “${rule.text}”`}
                            {...(readOnlyId === null ? {} : { disabled: true, describedBy: readOnlyId })}
                            onPress={() => { setNotice(null); setEditingId(rule.id); }}
                          />
                          <Button
                            variant="link"
                            label="Delete"
                            accessibilityLabel={`Delete “${rule.text}”`}
                            {...(readOnlyId === null ? {} : { disabled: true, describedBy: readOnlyId })}
                            onPress={() => { setNotice(null); setStaleError(remove.error); setDeleting(rule); }}
                          />
                        </Actions>
                      ) : null}
                    </>
                  )}
                </View>
              ))}
            </View>
          )}
        </Section>
      </Stack>
    );
  }

  return (
    <View>
      {notice === null ? null : <View style={styles.notice}><Notice text={notice} /></View>}
      <Columns
        main={(
          <Stack>
            <Body>
              Standing facts about how {shown} runs, like “Closed Mondays” or “Brunch only on weekends”. TownwiseAI reads them with
              every message you send. They never change Townwise’s forecast. For a day that’s different, add a note: a closure, a
              buyout or a private event with a guest count changes the forecast for its days.
            </Body>
            <Actions>
              <LinkButton href={locationHref(location.id, 'notes')} label="Open Notes" />
              <LinkButton href={locationHref(location.id, 'agent')} label="Ask TownwiseAI" />
            </Actions>
          </Stack>
        )}
      />
      <View style={styles.body}>
        {readOnlyId === null ? null : <ReadOnlyLine text={line} nativeID={readOnlyId} />}
        {content}
      </View>
      <ConfirmDialog
        visible={deleting !== null}
        title="Delete this rule?"
        body="TownwiseAI stops reading it from your next message."
        confirmLabel="Delete rule"
        pendingLabel="Deleting…"
        pending={remove.pending}
        error={remove.error === staleError ? null : remove.error}
        onConfirm={() => { if (deleting !== null) remove.run(deleting); }}
        onCancel={() => { setDeleting(null); }}
      />
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  notice: { marginBottom: theme.space[8] },
  body: { marginTop: theme.space[8], paddingTop: theme.space[8], borderTopWidth: 1, borderTopColor: c.border, gap: theme.space[8] },
  list: { borderTopWidth: 1, borderTopColor: c.border, maxWidth: 720 },
  row: { gap: theme.space[1], paddingVertical: theme.space[4], borderBottomWidth: 1, borderBottomColor: c.border },
  text: { ...theme.type.sub, color: c.white },
});
