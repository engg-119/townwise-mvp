import { useEffect, useState } from 'react';
import { Link } from 'expo-router';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { DefinitionList } from '../../portal/ui/DataTable';
import { SourceChips } from '../../portal/ui/SourceChip';
import { inlineTarget } from '../../portal/ui/text';
import { theme } from '../../theme';
import { targetWords } from '../dataLinks';
import { dataTarget, toolLine, viewRows, type DataTarget, type ToolContext, type ToolStep } from '../tools';

// The tool calls of a reply (spec P25): one row per call, each fading in as it starts while the reply streams; the
// timeline under "Working for" and "Worked for" (Worked.tsx) holds them. A done row opens to
// what it read, as dates, counts and its sources as chips, opening in a new tab (never rows of figures or raw data). No
// icons but the source chips' site logos (portal/ui/SourceChip.tsx, the chip every source link is): the mono status
// word ("Reading", "Read", "Couldn’t read") carries the state, in `text2`, `text3` or the error color. A step that read
// the team's own data has a link under its words to where that data is (spec P25 build note, 2026-11-18): the Calendar's
// day, or the Your data item or list (`dataTarget`, `hrefOf`); the words stay the button that opens what it read.

/** The path a read's data opens at, when the person may open it (ReplyView's, from dataLinks.ts); null for none. */
export type HrefOf = (target: DataTarget | null) => string | null;

/**
 * Fades its child in over `duration` (easeOut), or shows it at once under reduced motion or until that is known.
 * `appear` false (read once, when it mounts) shows it at once too, as the same element, so a parent can keep it in
 * place when it stops fading new children in.
 */
export function FadeIn(props: { children: React.ReactNode; duration?: number; appear?: boolean }): React.JSX.Element {
  const reduced = useReducedMotion();
  const [appear] = useState(props.appear ?? true);
  const animate = reduced === false && appear;
  const [opacity] = useState(() => new Animated.Value(animate ? 0 : 1));
  const duration = props.duration ?? theme.motion.fade;
  useEffect(() => {
    if (!animate) {
      opacity.setValue(1);
      return undefined;
    }
    const [x1, y1, x2, y2] = theme.motion.easeOut;
    const fade = Animated.timing(opacity, {
      toValue: 1, duration, easing: Easing.bezier(x1, y1, x2, y2), useNativeDriver: Platform.OS !== 'web',
    });
    fade.start();
    return () => { fade.stop(); };
  }, [animate, duration, opacity]);
  if (!animate) return <View>{props.children}</View>;
  return <Animated.View style={{ opacity }}>{props.children}</Animated.View>;
}

/** `ended`: the reply is no longer streaming, so a web search still running never finished (D37). */
function Row(props: { step: ToolStep; ctx: ToolContext; ended: boolean; hrefOf: HrefOf | undefined }): React.JSX.Element {
  const { step, ctx } = props;
  const [open, setOpen] = useState(false);
  const line = toolLine(step, ctx, props.ended);
  const target = dataTarget(step);
  const href = target === null ? null : props.hrefOf?.(target) ?? null;
  const words = target === null ? null : targetWords(target);
  const rows = step.state === 'done' ? viewRows(step.input, step.result, step.name) : [];
  const expandable = rows.length > 0 || line.sources.length > 0;
  const tone = step.state === 'running' ? styles.statusRunning : step.state === 'error' ? styles.statusError : styles.statusDone;
  const head = (
    <View style={styles.rowHead}>
      <Text style={styles.sentence}>
        {line.status === '' ? null : <Text style={[styles.status, tone]}>{line.status} </Text>}
        <Text style={step.state === 'error' ? styles.objectError : styles.object}>{line.object}</Text>
      </Text>
      {line.detail === null ? null : <Text style={styles.detail}>{line.detail}</Text>}
    </View>
  );
  return (
    <View style={styles.row}>
      {expandable ? (
        <Pressable
          role="button"
          aria-expanded={open}
          accessibilityLabel={line.detail === null ? line.sentence : `${line.sentence}. ${line.detail}`}
          accessibilityHint={open ? 'Hides what it read' : 'Shows what it read'}
          onPress={() => { setOpen((value) => !value); }}
          style={styles.press}
        >
          {head}
        </Pressable>
      ) : head}
      {href === null || words === null ? null : (
        <View style={styles.open}>
          <Link href={href} accessibilityLabel={words.label} style={styles.openLink}>{words.text}</Link>
        </View>
      )}
      {open ? (
        <View style={styles.expanded}>
          {rows.length === 0 ? null : <DefinitionList mono items={rows.map((row) => ({ term: row.term, value: row.value }))} />}
          <SourceChips sources={line.sources} target="_blank" rel="noopener" />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One row per call, each fading in as it starts while the reply streams; `live` false once the reply has ended. A row
 * stays the same element when the reply ends, so one the person opened stays open and nothing redraws.
 */
export function ToolGroup(props: { steps: readonly ToolStep[]; live: boolean; ctx: ToolContext; hrefOf?: HrefOf }): React.JSX.Element | null {
  const { steps, live, ctx } = props;
  if (steps.length === 0) return null;
  return (
    <View style={styles.group} testID="tool-group">
      {steps.map((step) => <FadeIn key={step.id} appear={live}><Row step={step} ctx={ctx} ended={!live} hrefOf={props.hrefOf} /></FadeIn>)}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  group: { gap: theme.space[1], borderLeftWidth: theme.stroke.hairline, borderLeftColor: c.border, paddingLeft: theme.space[3] },
  row: { gap: theme.space[2] },
  press: { minHeight: 44, justifyContent: 'center' },
  rowHead: { gap: 2, paddingVertical: theme.space[1] },
  sentence: { ...theme.type.small, color: c.white },
  status: { ...theme.type.label },
  statusRunning: { color: c.text2 },
  statusDone: { color: c.text3 },
  statusError: { color: c.error },
  object: { ...theme.type.small, color: c.white },
  objectError: { ...theme.type.small, color: c.error },
  detail: { ...theme.type.small, color: c.text2 },
  expanded: { gap: theme.space[2], paddingBottom: theme.space[2] },
  // A 44px target on web and native, the link's own line under the step's words.
  open: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  openLink: { ...theme.type.small, ...inlineTarget, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
});
