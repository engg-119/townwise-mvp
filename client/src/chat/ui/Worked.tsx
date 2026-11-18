import { useEffect, useId, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import type { ToolContext } from '../tools';
import type { MessagePart } from '../useTuningChat';
import { Collapse } from './Collapse';
import { ToolGroup, type HrefOf } from './ToolGroup';

// How long TownwiseAI worked on a reply (owner follow-up, spec P25), and the timeline of its thinking summary and
// steps. One component for the whole turn, mounted from the first event to the end and across a reattach: while the
// reply streams its header reads "Working for {n}s" (whole seconds since the person sent the message, redrawn once a
// second as plain text), and once it has ended "Worked for {n}s". Owner request, 2026-11-17 ("set it up so that the
// working for xs detail is closed on a new prompt but let the user open it. also add a smooth open/close animation and
// don't let it flash or glitch"): the timeline starts closed for every new prompt, and the header is a button
// (`aria-expanded`, `aria-controls`) that opens and closes it while the reply streams and after; the choice is the
// page's (workedOpen.ts, by the reply's key and node ids), so it holds as the reply streams, ends and is read again.
// The region opens and closes smoothly (Collapse.tsx, Collapse.web.tsx), at once under reduced motion, and steps
// arriving while it is open grow it. The header keeps one height, whether or not there is anything to open yet, so
// nothing moves when the first step arrives. Neither line is ever in a live region: the page says only "TownwiseAI is
// replying" and "TownwiseAI replied", so a screen reader is not read a counter every second, or the thinking text.

/** A part of the timeline: the thinking summary and the tool steps, in the order they happened. */
export type ProcessPart = Extract<MessagePart, { type: 'thinking' | 'tools' }>;

export function isProcessPart(part: MessagePart): part is ProcessPart {
  return part.type === 'thinking' || part.type === 'tools';
}

export const wholeSeconds = (from: number, to: number): number => Math.max(0, Math.floor((to - from) / 1000));

/** Whole seconds since `startedAt`, redrawn once a second while `live`. */
function useElapsed(startedAt: number, live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [live]);
  return wholeSeconds(startedAt, now);
}

function Timeline(props: { parts: readonly ProcessPart[]; live: boolean; ctx: ToolContext; hrefOf: HrefOf | undefined }): React.JSX.Element {
  return (
    <View style={styles.timeline}>
      {props.parts.map((part) => (part.type === 'thinking'
        ? <Text key={part.key} style={styles.thinking}>{part.text}</Text>
        : <ToolGroup key={part.key} steps={part.steps} live={props.live} ctx={props.ctx} {...(props.hrefOf === undefined ? {} : { hrefOf: props.hrefOf })} />))}
    </View>
  );
}

/**
 * The reply's top. `live`: it streams, and counts from `startedAt`; ended, it shows `seconds` ("Worked" when the time
 * was not stored). A button over the timeline when there is one; plain text when there is nothing to open yet (or the
 * reply had no thinking summary or steps), and nothing for an ended reply with neither a time nor a timeline.
 */
export function Worked(props: {
  live: boolean;
  startedAt: number;
  seconds: number | null;
  parts: readonly ProcessPart[];
  ctx: ToolContext;
  open: boolean;
  onOpen: (open: boolean) => void;
  /** Where a step that read the team's own data opens (ToolGroup). */
  hrefOf?: HrefOf;
}): React.JSX.Element | null {
  const { live, open } = props;
  const elapsed = useElapsed(props.startedAt, live);
  const id = `worked-${useId().replace(/:/g, '')}`;
  const seconds = live ? elapsed : props.seconds;
  const verb = live ? 'Working' : 'Worked';
  const label = seconds === null ? verb : `${verb} for ${String(seconds)}s`;
  // Its name says the unit in full: some screen readers read "12s" as "12 s".
  const name = seconds === null ? label : `${verb} for ${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
  const any = props.parts.length > 0;
  if (!any && seconds === null) return null;
  return (
    <View style={styles.block} testID="worked">
      <View style={styles.head}>
        {any ? (
          <Pressable
            role="button"
            accessibilityLabel={name}
            aria-expanded={open}
            aria-controls={id}
            accessibilityState={{ expanded: open }}
            onPress={() => { props.onOpen(!open); }}
            style={styles.toggle}
          >
            <Text style={styles.toggleText}>{label}</Text>
          </Pressable>
        ) : <Text style={styles.counter}>{label}</Text>}
      </View>
      {any ? (
        <Collapse id={id} open={open}>
          <Timeline parts={props.parts} live={live} ctx={props.ctx} hrefOf={props.hrefOf} />
        </Collapse>
      ) : null}
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  block: { minWidth: 0 },
  head: { minHeight: 44, justifyContent: 'center', alignItems: 'flex-start' },
  counter: { ...theme.type.small, color: c.text2 },
  // The space under the header is inside the region, so a closed one takes none.
  timeline: { gap: theme.space[2], minWidth: 0, paddingTop: theme.space[2] },
  thinking: { ...theme.type.small, color: c.text2 },
  toggle: { minHeight: 44, justifyContent: 'center' },
  toggleText: { ...theme.type.small, color: c.text2, textDecorationLine: 'underline', textDecorationColor: c.line },
});
