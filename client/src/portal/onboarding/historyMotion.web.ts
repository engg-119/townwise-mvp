import { theme } from '../../theme';
import { HISTORY_ID } from '../home/HistoryCard';
import type { Box } from './historyMotion';

// The Reading calendar's move into Home's history card on web (storage2 2.2, spec P11): when reading is done the
// step measures its calendar, Home reloads and draws its history card (root id "home-history"), and the card grows
// from where the calendar was into its own place, once, in 280ms. With reduced motion the card just appears. Either
// way, if the step's own controls held focus, focus moves to the card's region, so it isn't left on the page body.
// Plain DOM and the Web Animations API, no stylesheet or script: nothing the CSP has to allow.

export type { Box };

const WAIT_MS = 5000;
const STEP_MS = 50;

export function boxOf(nativeID: string): Box | null {
  const element = document.getElementById(nativeID);
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function lostFocus(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

function land(card: HTMLElement, from: Box | null, animate: boolean): void {
  const region = card.querySelector<HTMLElement>('[role="region"]') ?? card;
  if (lostFocus()) {
    region.setAttribute('tabindex', '-1');
    region.focus({ preventScroll: true });
  }
  if (!animate || from === null || typeof card.animate !== 'function') return;
  const to = card.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return;
  const dx = from.x - to.left;
  const dy = from.y - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  const [x1, y1, x2, y2] = theme.motion.easeInOut;
  card.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${String(dx)}px, ${String(dy)}px) scale(${String(sx)}, ${String(sy)})`, opacity: 0.6 },
      { transformOrigin: 'top left', transform: 'none', opacity: 1 },
    ],
    { duration: theme.motion.zoom, easing: `cubic-bezier(${String(x1)}, ${String(y1)}, ${String(x2)}, ${String(y2)})` },
  );
}

/** Waits up to 5 seconds for Home's history card, then moves it in from `from` (or only takes focus there). */
export function arriveAtHome(from: Box | null, animate: boolean): void {
  const started = Date.now();
  const look = (): void => {
    const card = document.getElementById(HISTORY_ID);
    if (card !== null) {
      land(card, from, animate);
      return;
    }
    if (Date.now() - started < WAIT_MS) setTimeout(look, STEP_MS);
  };
  setTimeout(look, STEP_MS);
}
