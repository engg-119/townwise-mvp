import { useLocalSearchParams } from 'expo-router';
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
import { EmptyState, ErrorNotice, Notice, ReadOnlyLine, useNoticeState } from '../ui/feedback';
import { FormField } from '../ui/FormField';
import { useFocusMessage } from '../ui/messageFocus';
import { Columns, Section, Stack } from '../ui/layout';
import { Body, Small } from '../ui/text';
import { alreadyDecidedRule, decideRuleSuggestion, type Rule, type RuleSchedule, type RuleSuggestion, type RuleWrite } from './api';
import { RuleSuggestionCard } from './RuleSuggestionCard';
import { checkSchedule, counterLine, draftOfSchedule, forecastLine, normalizeRule, RULES_COPY, ruleProblem } from './rules';
import { alreadyLine, decideErrorLine, SUGGESTED_COPY, toDecideLine } from './suggestionWords';
import { useRuleDecisions, type RuleDecision } from './useRuleDecisions';
import { useRules } from './useRules';

// P29 Business rules (spec 16.3, 10.16, D31; /locations/[id]/rules, members): standing facts about how the location
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
// disabled in place, described by the read-only line.
//
// Suggested by TownwiseAI (D46): above Add a rule, the location's open suggested closure rules, from files TownwiseAI
// read and from the sales history, each a RuleSuggestionCard. Any member confirms, edits or dismisses one; none changes
// the forecast until confirmed. Edit opens the rule form in the card, filled in (Every year included), and Save confirms
// the edited rule; `?suggestion={id}` (the TownwiseAI panel's Edit) opens that card's edit. A confirmed card moves its
// rule into the list in place (useRules settle), and a dismissed one goes, each with a notice; a Confirm another tab won
// (409 already_decided) moves that tab's rule in. A suggestion gone in the meantime (404) says so and loads the page
// again. 409 rule_exists offers the saved rule with the same words, which needs a schedule to close anything.

const READ_ONLY_ID = 'rules-ro';
const LIMIT_ID = 'rules-limit';
/** The API's word for an author whose account is gone (api/src/people.ts DELETED_PERSON). */
const DELETED_PERSON = 'Deleted person';
/** The API's author for a rule TownwiseAI added on its own (api/src/people.ts TOWNWISE_AI, D59 slice 3). */
const TOWNWISE_AI = 'TownwiseAI';

/**
 * “Added by owner@example.com, Mar 2, 2026”, “Saved from TownwiseAI by …” for a rule saved from a chat card, or (D59
 * slice 3) “Added by TownwiseAI on its own, …” for one it was sure of, with “, changed since” once someone edited it (it
 * is then a person's, and TownwiseAI's Undo no longer takes it back). [CONFIRM: the words for what TownwiseAI saves from
 * its weekly suggestions and the sales history]
 */
function addedLine(rule: Rule): string {
  if (rule.createdByEmail === TOWNWISE_AI) {
    return `Added by TownwiseAI on its own, ${formatDate(rule.createdAt)}${rule.updatedAt === rule.createdAt ? '' : ', changed since'}`;
  }
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

function scheduleState(rule: { schedule?: RuleSchedule | null | undefined } | null): ScheduleState {
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
  /** A suggestion's Edit (D46): the field takes focus as the form opens, which also brings it into view. */
  autoFocus?: boolean;
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
        {...(props.autoFocus === true ? { autoFocus: true } : {})}
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
 * A row in edit, or a suggested rule's Edit (D46): the field with the rule's text, its schedule (open when it has one),
 * Save and Cancel. Save sends the schedule when the rule has one or the section is open, null when the section was
 * closed on a rule that had one.
 */
function EditRule(props: {
  rule: { text: string; schedule?: RuleSchedule | null | undefined };
  idPrefix: string;
  save: (write: RuleWrite) => Promise<unknown>;
  onSaved: () => void;
  onCancel: () => void;
  onRefused: (error: unknown) => boolean;
  /** A refusal's words, when the caller words it (a suggestion's); else the page's write errors. */
  errorLine?: (error: unknown, text: string) => string;
  /** The text field takes focus as the form opens (a suggestion's Edit). */
  autoFocus?: boolean;
}): React.JSX.Element {
  const { rule, save, onSaved, onRefused } = props;
  const [text, setText] = useState(rule.text);
  const [problem, setProblem] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleState>(() => scheduleState(rule));
  const action = useAction(useCallback(async (write: RuleWrite) => {
    try {
      await save(write);
    } catch (error) {
      if (onRefused(error)) return;
      throw error;
    }
    onSaved();
  }, [save, onSaved, onRefused]));

  function submit(): void {
    if (action.pending) return;
    const found = ruleProblem(text);
    setProblem(found);
    const sent = scheduleToSend(schedule, setSchedule, (rule.schedule ?? null) !== null);
    if (found === null && sent !== null) action.run({ text: normalizeRule(text), ...sent });
  }

  return (
    <Stack>
      <RuleField
        label="Edit rule"
        value={text}
        onChange={setText}
        onSubmit={submit}
        message={problem}
        readOnlyId={null}
        {...(props.autoFocus === true ? { autoFocus: true } : {})}
      />
      <ScheduleSection state={schedule} setState={setSchedule} idPrefix={props.idPrefix} readOnlyId={null} />
      {action.error === null ? null : <ErrorNotice message={(props.errorLine ?? writeError)(action.error, text)} />}
      <Actions>
        <Button variant="outline" label={action.pending ? 'Saving…' : 'Save'} disabled={action.pending} onPress={submit} />
        <Button variant="link" label="Cancel" onPress={props.onCancel} />
      </Actions>
    </Stack>
  );
}

/**
 * Suggested by TownwiseAI (D46): the open suggested closure rules, each a card, or the rule form filled in from it while
 * its Edit is open.
 */
function SuggestedGroup(props: {
  suggested: readonly RuleSuggestion[];
  locationId: string;
  readOnlyId: string | null;
  decisions: ReturnType<typeof useRuleDecisions>;
  editing: string | null;
  setEditing: (suggestionId: string | null) => void;
  /** The card whose Edit form was just canceled: its Edit takes focus back. */
  canceled: string | null;
  onCancel: (suggestionId: string) => void;
  save: (suggestion: RuleSuggestion, write: RuleWrite) => Promise<void>;
  onRefused: (error: unknown) => boolean;
  onEditExisting: (suggestion: RuleSuggestion) => void;
}): React.JSX.Element {
  const { suggested, decisions } = props;
  const open = suggested.filter((suggestion) => decisions.decided[suggestion.id] === undefined).length;
  return (
    <View role="region" aria-label={SUGGESTED_COPY.heading}>
      <Section first kicker={toDecideLine(open)} title={SUGGESTED_COPY.heading}>
        <Small>{SUGGESTED_COPY.lead}</Small>
        <View role="list" aria-label={SUGGESTED_COPY.heading} style={styles.suggested}>
          {suggested.map((suggestion) => (
            <View key={suggestion.id} role="listitem">
              {props.editing === suggestion.id && props.readOnlyId === null && suggestion.canDecide ? (
                <View style={styles.suggestionEdit}>
                  <EditRule
                    rule={suggestion}
                    idPrefix={`suggestion-${suggestion.id}`}
                    save={(write) => props.save(suggestion, write)}
                    onSaved={() => undefined}
                    onCancel={() => { props.onCancel(suggestion.id); }}
                    onRefused={props.onRefused}
                    autoFocus
                    errorLine={(error, text) => (hasCode(error, 400, 'invalid_request') ? writeError(error, text) : decideErrorLine(error))}
                  />
                </View>
              ) : (
                <RuleSuggestionCard
                  suggestion={suggestion}
                  locationId={props.locationId}
                  decisions={decisions}
                  readOnlyId={props.readOnlyId}
                  edit={{ onPress: () => { props.setEditing(suggestion.id); } }}
                  onEditExisting={() => { props.onEditExisting(suggestion); }}
                  focusEdit={props.canceled === suggestion.id}
                />
              )}
            </View>
          ))}
        </View>
      </Section>
    </View>
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
  const [notice, setNotice] = useNoticeState();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  // useAction keeps its last error until the next run; a dialog opened again starts without it.
  const [staleError, setStaleError] = useState<unknown>(null);
  // D46: the suggested rule whose Edit is open; the TownwiseAI panel's Edit opens one with ?suggestion=.
  const params = useLocalSearchParams<{ suggestion?: string }>();
  const [editingSuggestion, setEditingSuggestion] = useState<string | null>(params.suggestion ?? null);
  // The suggestion whose Edit was canceled, so its card's Edit takes focus back (UI review S2).
  const [canceledSuggestion, setCanceledSuggestion] = useState<string | null>(null);
  const { settle } = rules;
  // A decided card leaves the group, so its notice takes focus (UI review S1).
  const focusMessage = useFocusMessage();

  /** A suggested rule decided here or by another tab (409 already_decided): its rule into the list, and a notice. */
  const decided = useCallback((suggestionId: string, decision: RuleDecision) => {
    settle(suggestionId, decision.rule);
    setEditingSuggestion((current) => (current === suggestionId ? null : current));
    setCanceledSuggestion(null);
    if (decision.status === 'dismissed') setNotice(SUGGESTED_COPY.dismissed);
    // Decided elsewhere first, so this press did nothing: that stays in the page, never a toast.
    else if (decision.already && decision.rule !== null) setNotice(alreadyLine(decision.rule.text), true);
    else setNotice(decision.rule === null ? 'Added the rule.' : `Added the rule “${decision.rule.text}”.`);
    focusMessage();
  }, [settle, focusMessage, setNotice]);
  /** A suggested rule gone in the meantime (404): says so and loads the page again. */
  const suggestionGone = useCallback(() => {
    setEditingSuggestion(null);
    setCanceledSuggestion(null);
    setNotice(SUGGESTED_COPY.gone, true);
    focusMessage();
    reload();
  }, [reload, focusMessage, setNotice]);
  const decisions = useRuleDecisions(api, location.id, { onDecided: decided, onGone: suggestionGone });

  /** Edit's Save: confirms the suggestion as the edited rule. */
  const saveSuggestion = useCallback(async (suggestion: RuleSuggestion, write: RuleWrite) => {
    const result = await decideRuleSuggestion(api, location.id, suggestion.id, 'accept', { text: write.text, schedule: write.schedule ?? null });
    decided(suggestion.id, { status: result.suggestion.status, rule: result.rule, already: false });
  }, [api, location.id, decided]);
  /** Edit's refusals the page answers itself: another tab's Confirm (409 already_decided), and a 404. */
  const suggestionRefused = useCallback((error: unknown): boolean => {
    const stored = alreadyDecidedRule(error);
    if (stored !== null && editingSuggestion !== null) {
      decided(editingSuggestion, { status: 'accepted', rule: stored, already: true });
      return true;
    }
    if (!hasCode(error, 404, 'not_found')) return false;
    suggestionGone();
    return true;
  }, [decided, editingSuggestion, suggestionGone]);

  const gone = useCallback((text: string | null) => {
    setEditingId(null);
    setDeleting(null);
    // The rule is gone and the write did not happen: that stays in the page, never a toast.
    setNotice(text, true);
    reload();
  }, [reload, setNotice]);

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
  }, [removeRule, ruleGone, editingId, setNotice]));

  const { state } = rules;
  /** 409 rule_exists on a suggestion: the saved rule with its words opens for edit, so it can get a schedule. */
  const editExisting = (suggestion: RuleSuggestion): void => {
    const saved = state.status === 'ready'
      ? state.data.rules.find((rule) => normalizeRule(rule.text).toLowerCase() === suggestion.text.toLowerCase())
      : undefined;
    if (saved === undefined) { reload(); return; }
    setNotice(null);
    setEditingId(saved.id);
  };
  let content: React.ReactNode;
  if (state.status === 'loading') content = <RulesSkeleton label="Loading business rules" />;
  else if (state.status === 'failed') content = <LoadFailure error={state.error} onRetry={reload} />;
  else {
    const { rules: list, limit, suggested } = state.data;
    content = (
      <Stack gap={32}>
        {suggested.length === 0 ? null : (
          <SuggestedGroup
            suggested={suggested}
            locationId={location.id}
            readOnlyId={readOnlyId}
            decisions={decisions}
            editing={editingSuggestion}
            setEditing={(suggestionId) => { setNotice(null); setCanceledSuggestion(null); setEditingSuggestion(suggestionId); }}
            canceled={canceledSuggestion}
            onCancel={(suggestionId) => { setEditingSuggestion(null); setCanceledSuggestion(suggestionId); }}
            save={saveSuggestion}
            onRefused={suggestionRefused}
            onEditExisting={editExisting}
          />
        )}
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
                      idPrefix={`rule-${rule.id}`}
                      save={(write) => rules.edit(rule.id, write)}
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
      {notice === null ? null : <Notice text={notice.text} result={notice} stays={notice.stays} style={styles.notice} />}
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
  suggested: { gap: theme.space[3], maxWidth: 720 },
  suggestionEdit: { padding: theme.space[4], borderWidth: theme.stroke.hairline, borderColor: c.border, backgroundColor: c.panel },
});
