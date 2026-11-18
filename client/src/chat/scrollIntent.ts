// Whether the person is scrolling the thread, on web (spec P25 Scrolling; scrollPin.ts): a browser's scroll event says
// where the view is, never what moved it, so the person's own input is heard first, on the thread's scrolling element.
// A wheel or a trackpad, a finger dragging (a tap is no drag: pressing "Working for" on a phone is not a scroll), the
// scrollbar held, or a scroll key, each counts for as long as the scroll it starts can run: a smooth wheel or key
// scroll, a flick's momentum after the finger lifts. A jump to the end, content growing, the thread overflowing for
// the first time and layout moving under an animation come with none of these. Native has its own drag and momentum
// events (AgentChat).

/** A wheel's smooth scroll; a trackpad keeps sending wheel events through its momentum. */
const WHEEL_MS = 400;
/** A scroll key's smooth scroll. */
const KEY_MS = 600;
/** A flick's momentum once the finger lifts, or the scrollbar let go. */
const RELEASE_MS = 1000;

const KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/** Where these keys type or move a caret, not the page. */
const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Where Space presses the control, not the page ("Working for" is one). */
const PRESSABLE = 'button, a, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [role="tab"]';

export interface ScrollIntent {
  /** The person is scrolling now. */
  person: () => boolean;
  stop: () => void;
}

/** Listens on `node`, the thread's scrolling element, and its document, until `stop`. */
export function watchScrollIntent(node: HTMLElement, now: () => number = Date.now): ScrollIntent {
  let until = 0;
  let dragging = false;
  let grabbed = false;
  const extend = (ms: number): void => { until = Math.max(until, now() + ms); };
  const document = node.ownerDocument;

  const onWheel = (): void => { extend(WHEEL_MS); };
  const onTouchMove = (): void => { dragging = true; };
  const onTouchEnd = (): void => {
    if (dragging) extend(RELEASE_MS);
    dragging = false;
  };
  // The scrollbar is the scrolling element's own: a press on the content targets the content.
  const onPointerDown = (event: PointerEvent): void => { if (event.target === node && event.pointerType !== 'touch') grabbed = true; };
  const onPointerUp = (): void => {
    if (grabbed) extend(RELEASE_MS);
    grabbed = false;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    // Keys scroll the thread from inside it, or from the page itself when nothing has focus.
    if (target !== null && target !== document.body && !node.contains(target)) return;
    if (target?.closest(TYPING) != null) return;
    if (event.key === ' ' && target?.closest(PRESSABLE) != null) return;
    extend(KEY_MS);
  };

  const passive = { passive: true } as const;
  node.addEventListener('wheel', onWheel, passive);
  node.addEventListener('touchmove', onTouchMove, passive);
  node.addEventListener('touchend', onTouchEnd, passive);
  node.addEventListener('touchcancel', onTouchEnd, passive);
  node.addEventListener('pointerdown', onPointerDown, passive);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  return {
    person: () => dragging || grabbed || now() < until,
    stop: () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
      node.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
