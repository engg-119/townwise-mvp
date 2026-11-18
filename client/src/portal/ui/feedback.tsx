import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, type Href } from 'expo-router';
import { AccessibilityInfo, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { theme } from '../../theme';
import { errorCopy } from '../errors';
import { useBreakpoint } from '../hooks';
import { Button } from './Button';
import { useMessageTarget } from './messageFocus';
import { inlineTarget, Mono } from './text';
import { useToast, type ToastApi } from './toast';

// Messages, notices, errors, loading lines, empty states and status tags (spec 15.6, 15.7; shell.md 7.3, 7.8).
// No color carries meaning. What an action the person just took did (<Notice>: "Saved.", "Deleted the note.") is a
// toast at the bottom of the window that leaves by itself (ui/toast.tsx, D55). Everything else stays in the page, in
// white in the numbered, ruled list, until the page changes it: errors, field messages, and state that is no
// action's result (<InlineNotice>). Loading is one line of text that keeps the content's height. Nothing spins or
// shimmers.

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

/**
 * What an action the person just took did ("Saved.", "You joined {org}."): a toast, and no row in the page.
 *
 * Under a toast host (every signed-in screen: app/(gate)/(app)/_layout.tsx) it renders nothing where it is written
 * and shows its words as a toast: once as it mounts, in place when the words change, and again for a new `result`.
 * The toast then lives its own time, whatever the page does with the notice. With no host around it (a component
 * rendered alone in a test) it is the numbered `role="status"` row at this place in the page, as every notice was
 * before D55, so those tests still find its words; test/portal/ui/toast.test.web.tsx and the page tests that mount
 * the whole app cover the toast.
 */
export function Notice(props: {
  text: string;
  link?: MessageLink;
  /**
   * The action result the words are for, when the page keeps one: the same object never toasts twice (a notice that
   * mounts again with the page), and a new one toasts again though the words are the same.
   */
  result?: object;
  /**
   * For words that say the action did not happen ("This note isn’t available."): a failure is never a toast, so the
   * notice stays a row in the page under a host too, and takes focus as an error line does.
   */
  stays?: boolean;
  /** The row's box (its margin) where it is a row: no host mounted, or `stays`. */
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element | null {
  const toast = useToast();
  if (toast !== null && props.stays !== true) return <Toasted toast={toast} text={props.text} link={props.link} result={props.result} />;
  const row = <InlineNotice text={props.text} {...(props.link === undefined ? {} : { link: props.link })} />;
  return props.style === undefined ? row : <View style={props.style}>{row}</View>;
}

function Toasted(props: { toast: ToastApi; text: string; link: MessageLink | undefined; result: object | undefined }): null {
  const { toast, text, result } = props;
  const label = props.link?.label;
  const href = props.link?.href;
  const shown = useRef<number | undefined>(undefined);
  // A layout effect, so the toast is on screen in the same paint as the page's own change, not a frame after it.
  useLayoutEffect(() => {
    shown.current = toast.show(
      { text, ...(label === undefined || href === undefined ? {} : { link: { label, href } }) },
      { ...(shown.current === undefined ? {} : { replaces: shown.current }), ...(result === undefined ? {} : { result }) },
    );
  }, [toast, text, label, href, result]);
  // When the action took the focused control away, the page's heading takes focus in the toast's place.
  useMessageTarget(text, true);
  return null;
}

/**
 * A page's notice, kept as one object per action: `<Notice text={notice.text} result={notice} stays={notice.stays} />`.
 * Each set is a new result, so the same words set twice in a row ("Deleted the note." for a second note) are two
 * toasts, and a notice that mounts again with its page is not. `stays`: the words say the action did not happen, so
 * they stay in the page.
 */
export interface NoticeState { text: string; stays: boolean }

export function useNoticeState(): [NoticeState | null, (text: string | null, stays?: boolean) => void] {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  return [notice, useCallback((text: string | null, stays = false) => { setNotice(text === null ? null : { text, stays }); }, [])];
}

/**
 * A line of standing state that is no action's result ("This location isn’t available.", no forecast published
 * yet): `role="status"`, a row in the page until the page changes it. Never a toast.
 */
export function InlineNotice(props: { text: string; link?: MessageLink }): React.JSX.Element {
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
