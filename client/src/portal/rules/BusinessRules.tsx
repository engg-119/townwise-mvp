import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { errorCopy, hasCode } from '../errors';
import { formatDate } from '../format';
import { useAction, useBreakpoint } from '../hooks';
import { LoadFailure } from '../locations/parts';
import { shownLocationName } from '../locations/naming';
import { NoteFields } from '../locations/NoteFields';
import { emptyDraft, type NoteDraft, type NoteMessages, type ScheduleInput } from '../locations/noteRules';
import { SCRIPT_FOCUS, useFocusOnMount } from '../places/focus';
import { usePortal, useReadOnly } from '../PortalProvider';
import { locationHref } from '../routing';
import { useLocation } from '../shell/LocationShell';
import { RulesSkeleton } from '../skeleton';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState, ErrorNotice, Notice, ReadOnlyLine } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { Columns, Section, Stack } from '../ui/layout';
import { Body, Small } from '../ui/text';
import type { Rule, RuleWrite } from './api';
import { checkSchedule, counterLine, draftOfSchedule, forecastLine, normalizeRule, RULES_COPY, ruleProblem } from './rules';
import { useRules } from './useRules';

// P28 Business rules (spec 16.3, 10.16, D31; /locations/[id]/rules, members): standing facts about how the location
// runs, which TownwiseAI reads with every message the person sends. A rule changes Townwise's forecast only with a
// schedule: Add and Edit have an optional “Change the forecast” section with the note form's fields and checks
// (NoteFields, checkSchedule), and “Remove from the forecast” takes it off. Either button goes when pressed, so focus
// moves to what takes its place: the section's heading, or the line that says the forecast won't change (web focus,
// the screen reader on native; places/focus.ts). Each rule says under it whether it changes
// the forecast, with its schedule in the API's words. The page is the top bar's Rules section. “New rule” and the page's one primary,
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

const SCHEDULE_HELP = 'Optional. Without it, TownwiseAI reads the rule and the forecast doesn’t change.';
const SCHEDULE_LEAD = 'Townwise applies this to its forecast as it applies a note: a closure, a buyout or a private event with a guest count changes the days it covers.';

/** The “Change the forecast” section's state: open or not, the note form's draft and its field messages. */
interface ScheduleState {
  open: boolean;
  draft: NoteDraft;
  messages: NoteMessages;
  /**
   * The section last opened or closed from its own button, which went with the press, so the part that takes its place
   * takes focus as it mounts. False for a form as it starts (a page load, an edit opened, the add form after Add rule).
   */
  focus: boolean;
}

function scheduleState(rule: Rule | null): ScheduleState {
  const schedule = rule?.schedule ?? null;
  return { open: schedule !== null, draft: schedule === null ? emptyDraft('closure') : draftOfSchedule(schedule), messages: {}, focus: false };
}

type TextHost = React.ComponentRef<typeof Text>;

/**
 * The schedule to send, or null when the section's fields stop the form (their messages are set). `had`: the rule had a
 * schedule, so a closed section sends null to take it off; without one, a closed section sends nothing.
 */
function scheduleToSend(
  state: ScheduleState, setState: (next: ScheduleState) => void, had: boolean,
): { schedule?: ScheduleInput | null } | null {
  if (!state.open) {
    setState({ ...state, messages: {} });
    return had ? { schedule: null } : {};
  }
  const checked = checkSchedule(state.draft);
  setState({ ...state, messages: 'messages' in checked ? checked.messages : {} });
  return 'messages' in checked ? null : { schedule: checked.input };
}

interface SectionProps {
  state: ScheduleState;
  setState: (next: ScheduleState) => void;
  idPrefix: string;
  readOnlyId: string | null;
}

/** Closed: the button that opens the section, and the line that says why it is optional (focused after Remove). */
function ClosedSchedule(props: SectionProps): React.JSX.Element {
  const { state, setState } = props;
  const { phone } = useBreakpoint();
  const line = useFocusOnMount<TextHost>(state.focus);
  return (
    <Stack gap={8}>
      <Actions>
        <Button
          variant="outline"
          label="Change the forecast"
          {...(props.readOnlyId === null ? {} : { disabled: true, describedBy: props.readOnlyId })}
          onPress={() => { setState({ ...state, open: true, focus: true }); }}
        />
      </Actions>
      {/* The `Small` type, on a Text of its own so it can take focus. */}
      <Text ref={line} {...SCRIPT_FOCUS} style={[phone ? theme.type.sub : theme.type.small, styles.help]}>{SCHEDULE_HELP}</Text>
    </Stack>
  );
}

/** Open: a group with its heading (focused as it opens), the note form's fields and “Remove from the forecast”. */
function OpenSchedule(props: SectionProps): React.JSX.Element {
  const { state, setState } = props;
  const heading = useFocusOnMount<TextHost>(state.focus);
  return (
    <View role="group" aria-label="Change the forecast" style={styles.schedule}>
      <Text ref={heading} {...SCRIPT_FOCUS} style={styles.scheduleHead}>Change the forecast</Text>
      <Small>{SCHEDULE_LEAD}</Small>
      <NoteFields
        draft={state.draft}
        set={(patch) => { setState({ ...state, draft: { ...state.draft, ...patch } }); }}
        messages={state.messages}
        idPrefix={props.idPrefix}
        endHelper="Leave it empty to keep it going."
        noun="rule"
      />
      <Actions>
        <Button variant="link" label="Remove from the forecast" onPress={() => { setState({ ...state, open: false, messages: {}, focus: true }); }} />
      </Actions>
    </View>
  );
}

/**
 * The optional “Change the forecast” part of the add form and a row's edit. Closed: a button that opens it, and why it is
 * optional. Open: a group with the note form's fields and “Remove from the forecast”, which closes it.
 */
function ScheduleSection(props: SectionProps): React.JSX.Element {
  return props.state.open ? <OpenSchedule {...props} /> : <ClosedSchedule {...props} />;
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

/** “New rule”, its optional schedule and “Add rule”. Text the API refused stays in the field, with why. */
function AddRule(props: {
  atLimit: boolean;
  readOnlyId: string | null;
  add: (write: RuleWrite) => Promise<Rule>;
  onAdded: () => void;
  onGone: () => void;
}): React.JSX.Element {
  const { add, onAdded, onGone } = props;
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState>(() => scheduleState(null));
  const action = useAction(useCallback(async (write: RuleWrite) => {
    try {
      await add(write);
    } catch (error) {
      // A new rule can only miss its location, which the list's reload reports.
      if (hasCode(error, 404, 'not_found')) { onGone(); return; }
      throw error;
    }
    setText('');
    setSchedule(scheduleState(null));
    onAdded();
  }, [add, onAdded, onGone]));
  const blockedBy = props.readOnlyId ?? (props.atLimit ? LIMIT_ID : null);

  function submit(): void {
    if (blockedBy !== null || action.pending) return;
    const found = ruleProblem(text);
    setProblem(found);
    const sent = scheduleToSend(schedule, setSchedule, false);
    if (found === null && sent !== null) action.run({ text: normalizeRule(text), ...sent });
  }

  return (
    <Stack>
      <RuleField label="New rule" value={text} onChange={setText} onSubmit={submit} message={problem} readOnlyId={blockedBy} />
      <ScheduleSection state={schedule} setState={setSchedule} idPrefix="rule-new" readOnlyId={blockedBy} />
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

/**
 * A row in edit: the field with the rule's text, its schedule (open when it has one), Save and Cancel. Save sends the
 * schedule when the rule has one or the section is open, null when the section was closed on a rule that had one.
 */
function EditRule(props: {
  rule: Rule;
  edit: (ruleId: string, write: RuleWrite) => Promise<Rule>;
  onSaved: () => void;
  onCancel: () => void;
  onRefused: (error: unknown) => boolean;
}): React.JSX.Element {
  const { rule, edit, onSaved, onRefused } = props;
  const [text, setText] = useState(rule.text);
  const [problem, setProblem] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState>(() => scheduleState(rule));
  const action = useAction(useCallback(async (write: RuleWrite) => {
    try {
      await edit(rule.id, write);
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
    const sent = scheduleToSend(schedule, setSchedule, (rule.schedule ?? null) !== null);
    if (found === null && sent !== null) action.run({ text: normalizeRule(text), ...sent });
  }

  return (
    <Stack>
      <RuleField label="Edit rule" value={text} onChange={setText} onSubmit={submit} message={problem} readOnlyId={null} />
      <ScheduleSection state={schedule} setState={setSchedule} idPrefix={`rule-${rule.id}`} readOnlyId={null} />
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
  if (state.status === 'loading') content = <RulesSkeleton label="Loading business rules" />;
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
                      <Small white={(rule.schedule ?? null) !== null}>{forecastLine(rule)}</Small>
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
              every message you send. A rule changes Townwise’s forecast only when you give it a schedule under Change the forecast: a
              closure, a buyout or a private event with a guest count, on the days you choose. For one day that’s different, add a note.
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
  schedule: { gap: theme.space[5], paddingLeft: theme.space[4], borderLeftWidth: 1, borderLeftColor: c.line, minWidth: 0 },
  // The Mono type in text3 (ui/text.tsx), and the Small type's text2, each on a Text that can take focus.
  scheduleHead: { ...theme.type.mono, fontVariant: ['tabular-nums'], color: c.text3 },
  help: { color: c.text2 },
});
