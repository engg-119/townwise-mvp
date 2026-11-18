import { useEffect, useState } from 'react';

import { useReducedMotion } from '../../motion';
import { theme } from '../../theme';

// The "Worked for" timeline's region on web (owner request, 2026-11-17: a smooth open and close that never flashes).
// A one-row grid whose row runs between 0fr and 1fr (a CSS transition, easeOut), so the height animates to the
// content's own with nothing measured, and a step arriving while it is open grows the row without starting over.
// Mounted open, it shows open at once. The content is mounted only while open or closing; it clips only while it
// moves or is closed (so a row's focus ring is never cut off once open), and is inert from the moment it starts
// closing. Under prefers-reduced-motion it opens and closes at once. Collapse.tsx is the native one.

export const COLLAPSE_MS = theme.motion.fade;

export function Collapse(props: { id: string; open: boolean; children: React.ReactNode }): React.JSX.Element {
  const { open } = props;
  const reduced = useReducedMotion();
  const [moving, setMoving] = useState(false);
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setMoving(!reduced);
  }
  useEffect(() => {
    if (!moving) return undefined;
    const done = setTimeout(() => { setMoving(false); }, COLLAPSE_MS);
    return () => { clearTimeout(done); };
  }, [moving, open]);
  const [x1, y1, x2, y2] = theme.motion.easeOut;
  return (
    <div
      id={props.id}
      data-testid="worked-region"
      style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridTemplateRows: open ? '1fr' : '0fr',
        transition: reduced ? 'none' : `grid-template-rows ${String(COLLAPSE_MS)}ms cubic-bezier(${String(x1)}, ${String(y1)}, ${String(x2)}, ${String(y2)})`,
      }}
    >
      <div style={{ minHeight: 0, minWidth: 0, overflow: moving || !open ? 'hidden' : 'visible' }} inert={!open}>
        {open || moving ? props.children : null}
      </div>
    </div>
  );
}
