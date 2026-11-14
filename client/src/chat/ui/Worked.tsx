import { useEffect, useId, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { ToolContext } from '../tools';
import type { MessagePart } from '../useTuningChat';
import { ToolGroup } from './ToolGroup';

// How long TownwiseAI worked on a reply (owner follow-up, spec P25). While the reply streams, "Working for {n}s"
// counts whole seconds since the person sent the message, redrawn once a second as plain text (no animation, so
// reduced motion changes nothing), above a timeline of the thinking summary as it streams and each step as it runs.
// Once the reply has ended, the timeline folds into a collapsed "Worked for {n}s" button that opens to the same
// summary and steps. Neither line is ever in a live region: the page says only "TownwiseAI is replying" and
// "TownwiseAI replied", so a screen reader is not read a counter every second, or the thinking text.

/** A part of the timeline: the thinking summary and the tool steps, in the order they happened. */
export type ProcessPart = Extract<MessagePart, { type: 'thinking' | 'tools' }>;

export function isProcessPart(part: MessagePart): part is ProcessPart {
  return part.type === 'thinking' || part.type === 'tools';
}

export const wholeSeconds = (from: number, to: number): number => Math.max(0, Math.floor((to - from) / 1000));

/** Whole seconds since `startedAt`, redrawn once a second while the component is mounted. */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, []);
  return wholeSeconds(startedAt, now);
}

function Timeline(props: { parts: readonly ProcessPart[]; live: boolean; ctx: ToolContext }): React.JSX.Element {
  return (
    <View style={styles.timeline}>
      {props.parts.map((part) => (part.type === 'thinking'
        ? <Text key={part.key} style={styles.thinking}>{part.text}</Text>
        : <ToolGroup key={part.key} steps={part.steps} live={props.live} ctx={props.ctx} />))}
    </View>
  );
}

/** The streaming reply's top: the counter, then the timeline under it. The counter alone says it is working. */
export function Working(props: { startedAt: number; parts: readonly ProcessPart[]; ctx: ToolContext }): React.JSX.Element {
  const seconds = useElapsed(props.startedAt);
  return (
    <View style={styles.block}>
      <Text style={styles.counter}>{`Working for ${String(seconds)}s`}</Text>
      {props.parts.length === 0 ? null : <Timeline parts={props.parts} live ctx={props.ctx} />}
    </View>
  );
}

/**
 * The ended reply's top: "Worked for {n}s" (just "Worked" when the time was not stored). A button that opens to the
 * timeline when there is one; plain text when the reply had no thinking summary or steps.
 */
export function Worked(props: { seconds: number | null; parts: readonly ProcessPart[]; ctx: ToolContext }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const id = `worked-${useId().replace(/:/g, '')}`;
  const label = props.seconds === null ? 'Worked' : `Worked for ${String(props.seconds)}s`;
  // Its name says the unit in full: some screen readers read "12s" as "12 s".
  const name = props.seconds === null ? label : `Worked for ${String(props.seconds)} ${props.seconds === 1 ? 'second' : 'seconds'}`;
  if (props.parts.length === 0) return props.seconds === null ? null : <Text style={styles.counter}>{label}</Text>;
  return (
    <View style={styles.block}>
      <Pressable
        role="button"
        accessibilityLabel={name}
        aria-expanded={open}
        aria-controls={id}
        accessibilityState={{ expanded: open }}
        onPress={() => { setOpen((value) => !value); }}
        style={styles.toggle}
      >
        <Text style={styles.toggleText}>{label}</Text>
      </Pressable>
      {open ? <View nativeID={id} id={id}><Timeline parts={props.parts} live={false} ctx={props.ctx} /></View> : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  block: { gap: theme.space[2], minWidth: 0 },
  counter: { ...theme.type.small, color: c.text2 },
  timeline: { gap: theme.space[2], minWidth: 0 },
  thinking: { ...theme.type.small, color: c.text2 },
  toggle: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  toggleText: { ...theme.type.small, color: c.text2, textDecorationLine: 'underline', textDecorationColor: c.line },
});
