// The message log's bottom pin (spec P25, after Coffee Chats): while pinned, new content keeps the end in view;
// the person scrolling up unpins it, and coming back down to the end pins it again. A pure function of the log's
// scroll events, so the rules are tested without a layout.
//
// A scroll up is the view moving up and ending more than UNPIN_PX from the end (owner, 2026-11-18: "as the prompt goes
// it should scroll down automatically unless the user scrolls up and breaks that"). The view also moves up when the
// content shrinks under a pinned view (the timeline closing, a reply read back shorter): the browser pulls the offset
// back to the new end, and when the new height was heard first (`contentGrew`) that looked like a scroll up and
// unpinned the log, so later growth was flagged, not followed. A view still at the end was not scrolled up, whatever
// moved it; an iOS bounce at the end is not one either.

export interface PinState {
  pinned: boolean;
  lastY: number;
  lastHeight: number;
  /** Content arrived below the view while unpinned: the Latest button shows. */
  behind: boolean;
}

export type PinEvent =
  | { type: 'scroll'; y: number; contentHeight: number; viewportHeight: number }
  /** The person's own send. */
  | { type: 'send' }
  /** A conversation opened, or a new one started. */
  | { type: 'opened' }
  /** The Latest button. */
  | { type: 'latest' }
  | { type: 'contentGrew'; contentHeight: number };

/** What the log does after the event: nothing, jump to the end, or move to it (animated unless reduced motion). */
export type PinScroll = 'none' | 'jump' | 'move';

/** A view moved up to more than this from the end unpins (wheel and trackpad too, which never fire a drag). */
const UNPIN_PX = 4;
/** Coming down to within this of the end pins again. */
const REPIN_PX = 40;

export const INITIAL_PIN: PinState = { pinned: true, lastY: 0, lastHeight: 0, behind: false };

export function nextPin(state: PinState, event: PinEvent): { state: PinState; scroll: PinScroll } {
  switch (event.type) {
    case 'send':
    case 'latest':
      return { state: { ...state, pinned: true, behind: false }, scroll: 'move' };
    case 'opened':
      return { state: { ...state, pinned: true, behind: false }, scroll: 'jump' };
    case 'contentGrew':
      if (state.pinned) return { state: { ...state, lastHeight: event.contentHeight }, scroll: 'jump' };
      return { state: { ...state, lastHeight: event.contentHeight, behind: event.contentHeight > state.lastHeight || state.behind }, scroll: 'none' };
    case 'scroll': {
      const moved = event.y - state.lastY;
      const shrank = event.contentHeight < state.lastHeight;
      const fromEnd = event.contentHeight - event.viewportHeight - event.y;
      const next = { ...state, lastY: event.y, lastHeight: event.contentHeight };
      // Content that shrank (a tool group collapsing) moved the view, not the person: the pin stays as it was.
      if (shrank) return { state: next, scroll: state.pinned ? 'jump' : 'none' };
      if (moved < 0 && fromEnd > UNPIN_PX) return { state: { ...next, pinned: false }, scroll: 'none' };
      if (moved > 0 && fromEnd <= REPIN_PX) return { state: { ...next, pinned: true, behind: false }, scroll: 'none' };
      return { state: next, scroll: 'none' };
    }
  }
}
