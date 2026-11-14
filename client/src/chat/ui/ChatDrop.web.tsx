import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';
import type { ChatDropProps } from './ChatDrop';

// The TownwiseAI page's drop overlay on web (spec P25, D36). While the page is mounted, window listeners watch for a
// drag of files from outside the page (dataTransfer.types holds 'Files'; a drag that started on the page is not one),
// and only then is the overlay mounted: a fixed layer over the whole viewport, drawn after the page's body and outside
// the composer's dock, so the dock's measured height, the thread's end padding, Latest and scroll-padding never
// change. It takes no pointer events, so even a drag the page lost track of can't block a scroll or a press. The drag
// ends on the drop, when it leaves the window (a depth counter, or a leave to nothing outside the viewport), on
// dragend and on window blur; Escape while the overlay shows hides it until then, the drag showing no drop ('none') and
// a drop then ignored. With no dragover for WATCHDOG_MS (a browser sends them while the pointer is still), the overlay
// hides until the next one, keeping the depth. Dropped files go to the composer's chips, as the + adds them. When
// files can't be attached, the overlay says why, the drag shows no drop ('none'), so a browser never fires the drop,
// and any drop that comes anyway is prevented, so the browser never opens the file in the tab, and does nothing else.
// It is aria-hidden and never takes focus: the labelled + is the keyboard's way to attach, and the page announces
// what a drop did.

export const DROP_TITLE = 'Drop files to attach them to your message';
export const DROP_KEPT = 'They’re kept on Your data.';
/** With no dragover for this long, the drag ended where the page couldn't hear it, or left without a leave event. */
export const WATCHDOG_MS = 2000;

const c = theme.color;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/** A dragleave to nothing (relatedTarget null) at a point outside the viewport: the drag left the window. */
function leftWindow(event: DragEvent): boolean {
  if (event.relatedTarget instanceof EventTarget) return false;
  const { clientX: x, clientY: y } = event;
  return !(x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight);
}

function Overlay(props: { blocked: string | null; reduced: boolean }): React.JSX.Element {
  const { reduced } = props;
  // Mounted at opacity 0 and 98%, then moved to 1 and 100% after a frame, so the CSS transition runs.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (reduced) return undefined;
    const frame = requestAnimationFrame(() => { setEntered(true); });
    return () => { cancelAnimationFrame(frame); };
  }, [reduced]);
  const shown = reduced || entered;
  const [x1, y1, x2, y2] = theme.motion.easeOut;
  const timing = `${String(theme.motion.select)}ms cubic-bezier(${String(x1)}, ${String(y1)}, ${String(x2)}, ${String(y2)})`;
  return (
    <div
      aria-hidden="true"
      data-testid="chat-drop"
      style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 9000, pointerEvents: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: theme.space[4], boxSizing: 'border-box',
        backgroundColor: c.scrim, opacity: shown ? 1 : 0, transition: reduced ? 'none' : `opacity ${timing}`,
      }}
    >
      <div
        data-testid="chat-drop-box"
        style={{
          width: '100%', maxWidth: 480, boxSizing: 'border-box', padding: theme.space[8], backgroundColor: c.panel,
          borderWidth: 2, borderStyle: 'dashed', borderColor: c.mint, display: 'flex', flexDirection: 'column', gap: theme.space[2],
          transform: shown ? 'scale(1)' : 'scale(0.98)', transition: reduced ? 'none' : `transform ${timing}`,
        }}
      >
        <Text style={styles.title}>{props.blocked ?? DROP_TITLE}</Text>
        {props.blocked === null ? <Text style={styles.kept}>{DROP_KEPT}</Text> : null}
      </div>
    </div>
  );
}

export function ChatDrop(props: ChatDropProps): React.JSX.Element | null {
  const [dragging, setDragging] = useState(false);
  const reduced = useReducedMotion() !== false;
  // The listeners are set once; they read the page's newest answer here.
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });

  useEffect(() => {
    let depth = 0;
    // Escape hides the overlay until this drag ends; a drag from the page itself is never a drop of files.
    let dismissed = false;
    let inside = false;
    // Whether the overlay shows now, for Escape.
    let showing = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const stopWatching = (): void => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    };
    const hide = (): void => {
      stopWatching();
      showing = false;
      setDragging(false);
    };
    // The drag is over: only these reset the depth and Escape.
    const end = (): void => {
      depth = 0;
      dismissed = false;
      hide();
    };
    const over = (): void => {
      stopWatching();
      if (dismissed) return;
      // The overlay hides when dragovers stop, but the drag may not be over: the depth stays for its leave.
      watchdog = setTimeout(hide, WATCHDOG_MS);
      showing = true;
      setDragging(true);
    };
    const ours = (event: DragEvent): boolean => !inside && hasFiles(event);
    const onEnter = (event: DragEvent): void => {
      if (!ours(event)) return;
      event.preventDefault();
      depth += 1;
      over();
    };
    const onOver = (event: DragEvent): void => {
      if (!ours(event)) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = latest.current.blocked === null && !dismissed ? 'copy' : 'none';
      over();
    };
    const onLeave = (event: DragEvent): void => {
      if (!ours(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 || leftWindow(event)) end();
    };
    const onDrop = (event: DragEvent): void => {
      if (!ours(event)) return;
      // Never the browser's own drop, which would open the file in place of the page. A drop the drag refused
      // ('none': files can't be attached, or Escape hid the overlay) is one a browser never fires; if one comes, it
      // does nothing.
      event.preventDefault();
      const refused = latest.current.blocked !== null || dismissed;
      end();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!refused && files.length > 0) latest.current.onFiles(files);
    };
    const onStart = (): void => { inside = true; };
    const onDragEnd = (): void => {
      inside = false;
      end();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !showing) return;
      dismissed = true;
      hide();
    };
    const drags: [string, (event: DragEvent) => void][] = [
      ['dragenter', onEnter], ['dragover', onOver], ['dragleave', onLeave], ['drop', onDrop], ['dragstart', onStart], ['dragend', onDragEnd],
    ];
    // Capture, so the page's own elements (the composer's field) never take a file drop first.
    for (const [type, listener] of drags) window.addEventListener(type, listener as EventListener, true);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', onKey, true);
    return () => {
      for (const [type, listener] of drags) window.removeEventListener(type, listener as EventListener, true);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', onKey, true);
      stopWatching();
    };
  }, []);

  return dragging ? <Overlay blocked={props.blocked} reduced={reduced} /> : null;
}

const styles = StyleSheet.create({
  title: { ...theme.type.h3Phone, color: c.white },
  kept: { ...theme.type.small, color: c.text2 },
});
