import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { View } from 'react-native';

// Focus for the message that says how an action ended, when the action also took away the control that had focus.
// A dialog returns focus to its opener when it closes (spec 15.7), but some outcomes remove the opener: a P19
// decision takes its request out of the list, a P22 reload swaps the table for its loading line. Focus would then
// fall to the page body. The page calls `focusMessage()` in the update that closes the dialog, and the notice or
// error line shown in that update takes focus: one that just appeared or changed before one already on the page.
// Only inside <MessageFocus> (the staff console's frame); elsewhere it does nothing.
//
// A notice shown as a toast (ui/toast.tsx, D55) is no place for focus: a toast never takes it. Such a notice still
// offers itself, and what takes focus in its place is the heading the MessageFocus holds: the page's h1 (<Title>
// registers itself) or a nearer landmark that spreads `useFocusFallback()` (the calendar's day panel). A
// MessageFocus with none of its own uses the one around it. An error line takes focus itself, as before.

type Host = React.ComponentRef<typeof View>;

/** Anything that can take focus: a view, or the heading's text. */
interface Focusable { focus: () => void }

interface Offer {
  /** Null for a notice shown as a toast: the heading takes focus in its place. */
  target: Focusable | null;
  /** Appeared or changed in this update. */
  fresh: boolean;
}

interface MessageFocusValue {
  /** Changes on each focusMessage(), so every message on the page offers itself in that update. */
  request: number;
  ask: () => void;
  offer: (offer: Offer) => void;
  /** Names this MessageFocus's heading, which takes focus in place of a toast; returns how to take it back. */
  holdHeading: (target: Focusable | null) => () => void;
  /** That heading, or else the one of the MessageFocus around this one. */
  fallback: () => Focusable | null;
}

const MessageFocusContext = createContext<MessageFocusValue | null>(null);

export function MessageFocus(props: { children: React.ReactNode }): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const armed = useRef(false);
  const offers = useRef<Offer[]>([]);
  const outer = useContext(MessageFocusContext);
  const heading = useRef<Focusable | null>(null);
  const holdHeading = useCallback((target: Focusable | null) => {
    heading.current = target;
    return () => { if (heading.current === target) heading.current = null; };
  }, []);
  const fallback = useCallback(() => heading.current ?? outer?.fallback() ?? null, [outer]);
  const ask = useCallback(() => {
    armed.current = true;
    setRequest((value) => value + 1);
  }, []);
  const offer = useCallback((next: Offer) => {
    if (armed.current) offers.current.push(next);
  }, []);
  // A parent's effects run after its children's, so each message has made its offer by now.
  useEffect(() => {
    const made = offers.current;
    offers.current = [];
    if (!armed.current) return;
    armed.current = false;
    const taken = made.find((candidate) => candidate.fresh) ?? made[0];
    if (taken !== undefined) (taken.target ?? fallback())?.focus();
  }, [request, fallback]);
  const value = useMemo(() => ({ request, ask, offer, holdHeading, fallback }), [request, ask, offer, holdHeading, fallback]);
  return <MessageFocusContext.Provider value={value}>{props.children}</MessageFocusContext.Provider>;
}

function ignore(): void {
  return undefined;
}

/**
 * Asks for focus on the message the same update shows. Once the calling component has unmounted it does nothing,
 * so an answer that lands after staff moved to another console page never takes focus there.
 */
export function useFocusMessage(): () => void {
  const ask = useContext(MessageFocusContext)?.ask ?? ignore;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback(() => { if (mounted.current) ask(); }, [ask]);
}

/**
 * For notices and error lines: what to put on the message's own view so it can take focus (`tabIndex` -1 keeps
 * it out of the tab order). `text` is what the message says; null for a message that never takes focus. `toast`:
 * the message is shown as a toast and has no view in the page, so the heading takes focus in its place.
 */
export function useMessageTarget(text: string | null, toast = false): { ref?: RefObject<Host | null>; tabIndex?: -1 } {
  const focus = useContext(MessageFocusContext);
  const ref = useRef<Host>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const fresh = shown.current !== text;
    shown.current = text;
    if (focus === null) return;
    if (toast) focus.offer({ target: null, fresh });
    else if (ref.current !== null) focus.offer({ target: ref.current, fresh });
  }, [focus, text, toast]);
  return focus === null || text === null || toast ? {} : { ref, tabIndex: -1 };
}

/**
 * For the element that takes focus in place of a notice shown as a toast: spread on the page's h1 (<Title> does) or
 * on a nearer landmark. Outside a MessageFocus it adds nothing.
 */
export function useFocusFallback<T extends Focusable>(): { ref?: RefObject<T | null>; tabIndex?: -1 } {
  const focus = useContext(MessageFocusContext);
  const ref = useRef<T>(null);
  const hold = focus?.holdHeading;
  useEffect(() => hold?.(ref.current), [hold]);
  return focus === null ? {} : { ref, tabIndex: -1 };
}
