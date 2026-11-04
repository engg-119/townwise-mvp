import { useEffect, useRef, useState, type RefObject } from 'react';

import { useReducedMotion } from './useReducedMotion.web';

const WATCHDOG_MS = 1000;

// When an element counts as in view: the observer's threshold and margin, and the share of the element
// that must be inside them. showWhenReduced: with reduced motion it shows at once (true) or still waits
// for the view, then fades in (false).
export interface RevealView {
  threshold: number;
  ratio: number;
  rootMargin: string;
  showWhenReduced: boolean;
}

export interface Reveal<T extends Element> {
  ref: RefObject<T | null>;
  // The element starts hidden (its CSS hides it only while armed and not yet revealed).
  armed: boolean;
  revealed: boolean;
  // Revealed by focus, a keyboard action, so it appears without animating.
  instant: boolean;
  revealNow: () => void;
}

// A one-time reveal as the element scrolls into view inside `root`. Without IntersectionObserver
// it is never hidden; a 1000ms watchdog releases it if the observer never reports. The observer
// disconnects after the first reveal. `view` must be a constant: a new object restarts the observer.
export function useReveal<T extends Element>(root: RefObject<Element | null>, view: RevealView): Reveal<T> {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();
  const skip = reduced && view.showWhenReduced;
  const [armed] = useState(() => typeof IntersectionObserver === 'function');
  const [shown, setShown] = useState<'scroll' | 'focus' | null>(null);

  useEffect(() => {
    if (!armed || skip || shown !== null) return undefined;
    let reported = false;
    const observer = new IntersectionObserver((entries) => {
      reported = true;
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= view.ratio)) setShown('scroll');
    }, { root: root.current, threshold: view.threshold, rootMargin: view.rootMargin });
    if (ref.current !== null) observer.observe(ref.current);
    // A working observer reports within a frame of observe().
    const watchdog = setTimeout(() => { if (!reported) setShown('scroll'); }, WATCHDOG_MS);
    return () => {
      clearTimeout(watchdog);
      observer.disconnect();
    };
  }, [armed, skip, shown, root, view]);

  return {
    ref,
    armed,
    revealed: !armed || skip || shown !== null,
    instant: shown === 'focus',
    revealNow: () => { setShown((current) => current ?? 'focus'); },
  };
}
