import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { hasCode } from '../errors';
import { itemHref, locationHref } from '../routing';
import { Actions, Button, LinkButton } from '../ui/Button';
import { ErrorNotice } from '../ui/feedback';
import { Heading } from '../ui/text';
import type { RuleSuggestion } from './api';
import { forecastLine } from './rules';
import { alreadyLine, confirmedLine, decideErrorLine, originOf, SUGGESTED_COPY } from './suggestionWords';
import type { RuleDecisions } from './useRuleDecisions';

// A suggested closure rule (openspec change suggest-closure-rules, D46), on P29's "Suggested by TownwiseAI" group and
// P25's "Suggested rules", web and native. The card shows the rule in Townwise's words (the API's `text`), what it does
// to the forecast (its `scheduleSummary`), where it came from (the file, linked to its page, or the sales history's
// days) and Confirm, Edit and Dismiss. Nothing changes the forecast until someone confirms it. Under view-as (`canDecide`
// false, or the page's read-only line) the three stay in place, disabled and described by that line. Edit is P29's rule
// form: a press there, a link to P29's `?suggestion=` from the panel. Once decided here the card says what it did, and
// that line takes focus on web, since the pressed button is gone. A refusal shows on the card; 409 rule_exists also
// offers the saved rule with the same words, which closes nothing until it has a schedule.

type Host = React.ComponentRef<typeof View>;

export function RuleSuggestionCard(props: {
  suggestion: RuleSuggestion;
  locationId: string;
  decisions: RuleDecisions;
  /** The page's read-only line (view-as), or null. */
  readOnlyId: string | null;
  /** P29 opens its form in place; the panel links to P29's `?suggestion=`. */
  edit: { onPress: () => void } | { href: string };
  /** P29: opens the saved rule with these words for edit (409 rule_exists). The panel links to P29 instead. */
  onEditExisting?: () => void;
  /** P29: Edit takes focus as the card mounts, back from its form's Cancel. */
  focusEdit?: boolean;
}): React.JSX.Element {
  const { suggestion, decisions } = props;
  const { id, text } = suggestion;
  const helpId = `rule-suggestion-${id}-help`;
  const decided = decisions.decided[id];
  const error = decisions.errors[id];
  const deciding = decisions.deciding === id;
  const blockedBy = props.readOnlyId ?? (suggestion.canDecide ? null : helpId);
  const off = blockedBy !== null || decisions.deciding !== null;
  const describedBy = [props.readOnlyId, helpId].filter((value): value is string => value !== null).join(' ');
  const origin = originOf(suggestion);
  const decidedRef = useRef<Host>(null);
  const pressed = useRef(false);
  const isDecided = decided !== undefined;
  useEffect(() => {
    if (isDecided && pressed.current && Platform.OS === 'web') decidedRef.current?.focus();
    if (isDecided) pressed.current = false;
  }, [isDecided]);

  function press(decision: 'accept' | 'dismiss'): void {
    pressed.current = true;
    decisions.decide(id, decision);
  }

  let done: string | null = null;
  if (decided !== undefined) {
    if (decided.status === 'dismissed') done = SUGGESTED_COPY.dismissed;
    else if (decided.already && decided.rule !== null) done = alreadyLine(decided.rule.text);
    else done = confirmedLine(decided.rule?.text ?? text);
  }
  const offProps = { disabled: off, describedBy };
  const exists = error !== undefined && hasCode(error, 409, 'rule_exists');

  return (
    <View style={styles.card}>
      <Heading level={3}>{text}</Heading>
      <Text style={styles.context}>{forecastLine(suggestion)}</Text>
      {origin.ref === null
        ? <Text style={styles.context}>{origin.text}</Text>
        : <LinkButton href={itemHref(props.locationId, origin.ref)} label={origin.text} />}
      {done !== null ? (
        <View ref={decidedRef} {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})} role="status">
          <Text style={styles.done}>{done}</Text>
        </View>
      ) : (
        <>
          <View role="group" aria-label={text} style={styles.answers}>
            <Button variant="outline" label="Confirm" accessibilityLabel={`Confirm “${text}”`} {...offProps} onPress={() => { press('accept'); }} />
            {'href' in props.edit && blockedBy === null ? (
              <LinkButton variant="outline" label="Edit" accessibilityLabel={`Edit “${text}”`} href={props.edit.href} />
            ) : (
              <Button
                variant="outline"
                label="Edit"
                accessibilityLabel={`Edit “${text}”`}
                {...offProps}
                {...(props.focusEdit === true ? { focusOnMount: true } : {})}
                onPress={() => { if ('onPress' in props.edit) props.edit.onPress(); }}
              />
            )}
            <Button variant="outline" label="Dismiss" accessibilityLabel={`Dismiss “${text}”`} {...offProps} onPress={() => { press('dismiss'); }} />
          </View>
          <Text nativeID={helpId} style={styles.help}>{deciding ? SUGGESTED_COPY.saving : SUGGESTED_COPY.help}</Text>
        </>
      )}
      {error === undefined || done !== null ? null : <ErrorNotice message={decideErrorLine(error)} />}
      {exists && done === null ? (
        <Actions>
          {props.onEditExisting === undefined
            ? <LinkButton href={locationHref(props.locationId, 'rules')} label={SUGGESTED_COPY.openRules} />
            : <Button variant="link" label={SUGGESTED_COPY.editExisting} onPress={props.onEditExisting} />}
        </Actions>
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  card: {
    gap: theme.space[3], padding: theme.space[4], backgroundColor: c.panel, borderWidth: theme.stroke.hairline, borderColor: c.border,
    borderRadius: theme.radius.none,
  },
  context: { ...theme.type.small, color: c.text2 },
  answers: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2], alignItems: 'flex-start' },
  help: { ...theme.type.small, color: c.text3 },
  done: { ...theme.type.small, color: c.white },
});
