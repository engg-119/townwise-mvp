import { useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useReducedMotion } from '../../motion';
import { DefinitionList } from '../../portal/ui/DataTable';
import { SourceChips } from '../../portal/ui/SourceChip';
import { theme } from '../../theme';
import { toolLine, viewRows, type ToolContext, type ToolStep } from '../tools';

// The tool calls of a reply (spec P25): one row per call, each fading in as it starts while the reply streams; the
// "Worked for" disclosure (Worked.tsx) holds them once it is done. A done row opens to
// what it read, as dates, counts and its sources as chips, opening in a new tab (never rows of figures or raw data). No
// icons but the source chips' site logos (portal/ui/SourceChip.tsx, the chip every source link is): the mono status
// word ("Reading", "Read", "Couldn’t read") carries the state, in `text2`, `text3` or the error color.

/** Fades its child in over `duration` (easeOut), or shows it at once under reduced motion or until that is known. */
export function FadeIn(props: { children: React.ReactNode; duration?: number }): React.JSX.Element {
  const reduced = useReducedMotion();
  const animate = reduced === false;
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

function Row(props: { step: ToolStep; ctx: ToolContext }): React.JSX.Element {
  const { step, ctx } = props;
  const [open, setOpen] = useState(false);
  const line = toolLine(step, ctx);
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
      {open ? (
        <View style={styles.expanded}>
          {rows.length === 0 ? null : <DefinitionList mono items={rows.map((row) => ({ term: row.term, value: row.value }))} />}
          <SourceChips sources={line.sources} target="_blank" rel="noopener" />
        </View>
      ) : null}
    </View>
  );
}

/** One row per call, each fading in as it starts while the reply streams. */
export function ToolGroup(props: { steps: readonly ToolStep[]; live: boolean; ctx: ToolContext }): React.JSX.Element | null {
  const { steps, live, ctx } = props;
  if (steps.length === 0) return null;
  return (
    <View style={styles.group} testID="tool-group">
      {steps.map((step) => (live ? <FadeIn key={step.id}><Row step={step} ctx={ctx} /></FadeIn> : <Row key={step.id} step={step} ctx={ctx} />))}
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
});
