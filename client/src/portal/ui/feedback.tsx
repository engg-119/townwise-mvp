import { useEffect } from 'react';
import { Link, type Href } from 'expo-router';
import { AccessibilityInfo, Platform, StyleSheet, Text, View } from 'react-native';

import { theme } from '../../theme';
import { errorCopy } from '../errors';
import { useBreakpoint } from '../hooks';
import { Button } from './Button';
import { useMessageTarget } from './messageFocus';
import { inlineTarget, Mono } from './text';

// Messages, notices, errors, loading lines, empty states and status tags (spec 15.6, 15.7; shell.md 7.3, 7.8).
// No colour carries meaning: messages print in white in the numbered, ruled list, with no toast and no
// auto-dismiss. Loading is one line of text that keeps the content's height. Nothing spins or shimmers.

export interface MessageLink { label: string; href: string }

/** The numbered, ruled message list (`.msgs`): field messages, notices and errors. */
export function Messages(props: {
  items: readonly string[];
  nativeID?: string;
  /** A link after the last message, ended with a full stop ("Leave {org}."). */
  link?: MessageLink;
  /** `alert` for errors, `status` for notices: on the text, where native screen readers find it. */
  live?: 'alert' | 'status';
  /** Notices and error lines: takes focus when the page asks for it (ui/messageFocus.tsx). */
  takesFocus?: boolean;
}): React.JSX.Element {
  const live = props.live === undefined ? {} : { role: props.live, 'aria-live': props.live === 'alert' ? 'assertive' as const : 'polite' as const };
  const target = useMessageTarget(props.takesFocus === true ? props.items.join('\n') : null);
  return (
    <View nativeID={props.nativeID} {...target} style={styles.list}>
      {props.items.map((item, index) => (
        <View key={index} style={styles.item}>
          <Mono tone="text3" style={styles.counter}>{String(index + 1).padStart(2, '0')}</Mono>
          <Text {...live} style={styles.message}>
            {item}
            {props.link !== undefined && index === props.items.length - 1 ? (
              <>
                {' '}
                <Link href={props.link.href as Href} style={styles.link}>{props.link.label}</Link>
                .
              </>
            ) : null}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A page notice ("Saved.", "You joined {org}."): `role="status"`, at the top of the content. */
export function Notice(props: { text: string; link?: MessageLink }): React.JSX.Element {
  return <Messages live="status" takesFocus items={[props.text]} {...(props.link === undefined ? {} : { link: props.link })} />;
}

/**
 * An error the person can act on: the shared copy (or `message`), as an alert, with an outline “Try again”.
 * It arrives after a press, away from focus, so iOS announces it too.
 */
export function ErrorNotice(props: { error?: unknown; message?: string; onRetry?: () => void; retryLabel?: string }): React.JSX.Element {
  const text = props.message ?? errorCopy(props.error);
  useEffect(() => {
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
  return (
    <View style={styles.error}>
      <Messages live="alert" takesFocus items={[text]} />
      {props.onRetry === undefined ? null : <Button variant="outline" label={props.retryLabel ?? 'Try again'} onPress={props.onRetry} />}
    </View>
  );
}

/** Loading: a line of text in place of the content, in a box that keeps the content's height. */
export function LoadingLine(props: { text: string; minHeight?: number }): React.JSX.Element {
  return (
    <View style={{ minHeight: props.minHeight ?? 120 }}>
      <Text role="status" style={styles.loading}>{props.text}</Text>
    </View>
  );
}

/** An empty state: what is missing and what to do next, with the action as the page's primary or a text link. */
export function EmptyState(props: { text: string; children?: React.ReactNode }): React.JSX.Element {
  const { phone } = useBreakpoint();
  return (
    <View style={[styles.empty, phone ? styles.emptyPhone : null]}>
      <Text style={styles.emptyText}>{props.text}</Text>
      {props.children}
    </View>
  );
}

/** “Read-only while viewing as {email}.”: one line per form or section with writes, under view-as. */
export function ReadOnlyLine(props: { text: string; nativeID?: string }): React.JSX.Element | null {
  if (props.text === '') return null;
  return <Text nativeID={props.nativeID} style={styles.readOnly}>{props.text}</Text>;
}

/**
 * StatusTag, only for build status and kinds (spec 15.6): In progress (6px mint square), Planned (6px outlined
 * square), and a town's kind with no square. A client's own data state is plain words, never a tag.
 */
export function StatusTag(props: { label: string; kind?: 'progress' | 'planned' }): React.JSX.Element {
  return (
    <View style={styles.tag}>
      {props.kind === 'progress' ? <View style={styles.squareFill} /> : null}
      {props.kind === 'planned' ? <View style={styles.squareOutline} /> : null}
      <Text style={styles.tagText}>{props.label}</Text>
    </View>
  );
}

const c = theme.color;

const styles = StyleSheet.create({
  list: { borderTopWidth: 1, borderTopColor: c.border, maxWidth: 640 },
  item: {
    flexDirection: 'row', columnGap: theme.space[2], paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  counter: { width: 28, lineHeight: 24 },
  message: { ...theme.type.sub, color: c.white, flex: 1, minWidth: 0 },
  link: { ...inlineTarget, color: c.white, textDecorationLine: 'underline', textDecorationColor: c.line },
  error: { gap: theme.space[4], alignItems: 'flex-start' },
  loading: { ...theme.type.small, color: c.text2, paddingTop: 4 },
  empty: {
    gap: theme.space[4], alignItems: 'flex-start', paddingVertical: theme.space[8], paddingHorizontal: theme.space[5],
    backgroundColor: c.panel, borderWidth: 1, borderColor: c.border,
  },
  emptyPhone: { paddingVertical: theme.space[6], paddingHorizontal: theme.space[4] },
  emptyText: { ...theme.type.sub, color: c.text2, maxWidth: 600 },
  readOnly: { ...theme.type.small, color: c.text2 },
  tag: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', columnGap: 6, borderWidth: 1, borderColor: c.line,
    paddingVertical: 3, paddingHorizontal: 6,
  },
  tagText: { ...theme.type.label, color: c.text2 },
  squareFill: { width: 6, height: 6, backgroundColor: c.mint },
  squareOutline: { width: 6, height: 6, borderWidth: 1, borderColor: c.line },
});
