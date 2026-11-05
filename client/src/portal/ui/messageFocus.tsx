import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { View } from 'react-native';

// Focus for the message that says how an action ended, when the action also took away the control that had focus.
// A dialog returns focus to its opener when it closes (spec 15.7), but some outcomes remove the opener: a P19
// decision takes its request out of the list, a P22 reload swaps the table for its loading line. Focus would then
// fall to the page body. The page calls `focusMessage()` in the update that closes the dialog, and the notice or
// error line shown in that update takes focus: one that just appeared or changed before one already on the page.
// Only inside <MessageFocus> (the staff console's frame); elsewhere it does nothing.

type Host = React.ComponentRef<typeof View>;

interface Offer {
  target: Host;
  /** Appeared or changed in this update. */
  fresh: boolean;
}

interface MessageFocusValue {
  /** Changes on each focusMessage(), so every message on the page offers itself in that update. */
  request: number;
  ask: () => void;
  offer: (offer: Offer) => void;
}

const MessageFocusContext = createContext<MessageFocusValue | null>(null);

export function MessageFocus(props: { children: React.ReactNode }): React.JSX.Element {
  const [request, setRequest] = useState(0);
  const armed = useRef(false);
  const offers = useRef<Offer[]>([]);
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
    (made.find((candidate) => candidate.fresh) ?? made[0])?.target.focus();
  }, [request]);
  const value = useMemo(() => ({ request, ask, offer }), [request, ask, offer]);
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
 * it out of the tab order). `text` is what the message says; null for a message that never takes focus.
 */
export function useMessageTarget(text: string | null): { ref?: RefObject<Host | null>; tabIndex?: -1 } {
  const focus = useContext(MessageFocusContext);
  const ref = useRef<Host>(null);
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (text === null) return;
    const fresh = shown.current !== text;
    shown.current = text;
    if (focus !== null && ref.current !== null) focus.offer({ target: ref.current, fresh });
  }, [focus, text]);
  return focus === null || text === null ? {} : { ref, tabIndex: -1 };
}
