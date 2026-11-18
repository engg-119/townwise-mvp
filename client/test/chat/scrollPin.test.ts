import { INITIAL_PIN, nextPin, type PinEvent, type PinState } from '../../src/chat/scrollPin';

// spec P25: the log's bottom pin.

function run(events: PinEvent[], from: PinState = INITIAL_PIN): { state: PinState; scrolls: string[] } {
  let state = from;
  const scrolls: string[] = [];
  for (const event of events) {
    const next = nextPin(state, event);
    state = next.state;
    scrolls.push(next.scroll);
  }
  return { state, scrolls };
}

const VIEW = 500;

test('while pinned, new content keeps the end in view', () => {
  const { state, scrolls } = run([{ type: 'contentGrew', contentHeight: 800 }, { type: 'contentGrew', contentHeight: 900 }]);
  expect(state).toMatchObject({ pinned: true, behind: false });
  expect(scrolls).toEqual(['jump', 'jump']);
});

test('scrolling up more than 4px unpins; then new content shows Latest and does not move the view', () => {
  const pinned = run([{ type: 'contentGrew', contentHeight: 1000 }, { type: 'scroll', y: 500, contentHeight: 1000, viewportHeight: VIEW, person: false }]).state;
  expect(run([{ type: 'scroll', y: 497, contentHeight: 1000, viewportHeight: VIEW, person: true }], pinned).state.pinned).toBe(true);
  const { state, scrolls } = run([
    { type: 'scroll', y: 480, contentHeight: 1000, viewportHeight: VIEW, person: true },
    { type: 'contentGrew', contentHeight: 1200 },
  ], pinned);
  expect(state).toMatchObject({ pinned: false, behind: true });
  expect(scrolls).toEqual(['none', 'none']);
});

test('coming back down to within 40px of the end pins again and hides Latest', () => {
  const unpinned: PinState = { pinned: false, lastY: 300, lastHeight: 1200, behind: true };
  expect(run([{ type: 'scroll', y: 600, contentHeight: 1200, viewportHeight: VIEW, person: true }], unpinned).state.pinned).toBe(false);
  expect(run([{ type: 'scroll', y: 665, contentHeight: 1200, viewportHeight: VIEW, person: true }], unpinned).state).toMatchObject({ pinned: true, behind: false });
});

test('content that shrank (a tool group folding) is not the person scrolling: the pin stays', () => {
  const pinned: PinState = { pinned: true, lastY: 700, lastHeight: 1200, behind: false };
  const { state, scrolls } = run([{ type: 'scroll', y: 500, contentHeight: 1000, viewportHeight: VIEW, person: false }], pinned);
  expect(state.pinned).toBe(true);
  expect(scrolls).toEqual(['jump']);
});

test('the person’s own send, Latest and opening a conversation pin and go to the end', () => {
  const unpinned: PinState = { pinned: false, lastY: 0, lastHeight: 1200, behind: true };
  expect(nextPin(unpinned, { type: 'send' })).toEqual({ state: { ...unpinned, pinned: true, behind: false }, scroll: 'move' });
  expect(nextPin(unpinned, { type: 'latest' }).scroll).toBe('move');
  expect(nextPin(unpinned, { type: 'opened' })).toEqual({ state: { ...unpinned, pinned: true, behind: false }, scroll: 'jump' });
});

// Owner, 2026-11-18: "as the prompt goes it should scroll down automatically unless the user scrolls up and breaks that".

/** Pinned at the end of `height`, as after a jump. */
function pinnedAt(height: number): PinState {
  return { pinned: true, lastY: height - VIEW, lastHeight: height, behind: false };
}

test('follows every frame of an animated height change while pinned (the timeline opening, a chart drawn), each frame a jump', () => {
  const frames: PinEvent[] = [];
  // 200ms at 60fps: the region grows a little each frame, the jump lands, and its scroll event follows.
  for (let height = 1000; height <= 1240; height += 20) {
    frames.push({ type: 'contentGrew', contentHeight: height }, { type: 'scroll', y: height - VIEW, contentHeight: height, viewportHeight: VIEW, person: false });
  }
  const { state, scrolls } = run(frames, pinnedAt(1000));
  expect(state).toMatchObject({ pinned: true, behind: false, lastHeight: 1240 });
  expect(scrolls.filter((_, index) => index % 2 === 0).every((scroll) => scroll === 'jump')).toBe(true);
  // A scroll event that arrives before the jump lands (the content grew under the view) is no scroll up.
  expect(run([{ type: 'scroll', y: 500, contentHeight: 1100, viewportHeight: VIEW, person: false }, { type: 'contentGrew', contentHeight: 1100 }], pinnedAt(1000)).scrolls)
    .toEqual(['none', 'jump']);
});

test('content shrinking under a pinned view keeps the pin, even when the new height is heard before the scroll it caused', () => {
  // The timeline closes: each frame the height is heard first, then the browser's pull of the offset to the new end.
  const frames: PinEvent[] = [];
  for (let height = 1180; height >= 1000; height -= 20) {
    frames.push({ type: 'contentGrew', contentHeight: height }, { type: 'scroll', y: height - VIEW, contentHeight: height, viewportHeight: VIEW, person: false });
  }
  const closed = run(frames, pinnedAt(1200)).state;
  expect(closed).toMatchObject({ pinned: true, behind: false });
  // So the reply growing after it is followed, not flagged.
  expect(nextPin(closed, { type: 'contentGrew', contentHeight: 1300 })).toMatchObject({ state: { pinned: true, behind: false }, scroll: 'jump' });
});

test('an iOS bounce at the end is no scroll up', () => {
  const { state } = run([
    { type: 'scroll', y: 560, contentHeight: 1000, viewportHeight: VIEW, person: true },
    { type: 'scroll', y: 520, contentHeight: 1000, viewportHeight: VIEW, person: true },
    { type: 'scroll', y: 500, contentHeight: 1000, viewportHeight: VIEW, person: true },
  ], pinnedAt(1000));
  expect(state.pinned).toBe(true);
});

test('a scroll up stops the following, even a slow one a few pixels at a time; nothing moves the view until the person comes back', () => {
  const slow = run([
    { type: 'scroll', y: 498, contentHeight: 1000, viewportHeight: VIEW, person: true },
    { type: 'scroll', y: 496, contentHeight: 1000, viewportHeight: VIEW, person: true },
    { type: 'scroll', y: 494, contentHeight: 1000, viewportHeight: VIEW, person: true },
  ], pinnedAt(1000));
  expect(slow.state.pinned).toBe(false);
  // The reply keeps streaming, the timeline opens and closes: the view stays where the person left it.
  const { state, scrolls } = run([
    { type: 'contentGrew', contentHeight: 1100 },
    { type: 'contentGrew', contentHeight: 1300 },
    { type: 'contentGrew', contentHeight: 1250 },
    { type: 'scroll', y: 494, contentHeight: 1250, viewportHeight: VIEW, person: false },
  ], slow.state);
  expect(scrolls).toEqual(['none', 'none', 'none', 'none']);
  expect(state).toMatchObject({ pinned: false, behind: true });
  // Back down near the end: pinned again, and the next growth is followed.
  const back = nextPin(state, { type: 'scroll', y: 720, contentHeight: 1250, viewportHeight: VIEW, person: true }).state;
  expect(back).toMatchObject({ pinned: true, behind: false });
  expect(nextPin(back, { type: 'contentGrew', contentHeight: 1400 }).scroll).toBe('jump');
  // A new prompt always goes to the end.
  expect(nextPin(state, { type: 'send' })).toMatchObject({ state: { pinned: true }, scroll: 'move' });
});

// An independent browser review, 2026-11-18: a new chat whose thread still fit, then "Working for" pressed. The
// timeline's 200ms open made the thread overflow for the first time; a scroll event arrived mid-growth, its offset short
// of an end that had already moved on (y 85, the end 146), and was read as a scroll up, so the rest of the reply streamed
// off screen behind Latest. Only a scroll the person makes unpins.

test('a thread that first overflows while the timeline opens stays pinned through a scroll event read mid-growth', () => {
  // Heights and offsets as AgentChat counts them, without the dock's 120: the browser's offset 85 is y -35, and its
  // scrollHeight 646 is 526. The view is 500.
  const fits = run([{ type: 'contentGrew', contentHeight: 300 }, { type: 'contentGrew', contentHeight: 380 }]).state;
  expect(fits).toMatchObject({ pinned: true, lastY: 0 });
  const { state, scrolls } = run([
    // A frame of the open animation passes the view for the first time, and the pinned thread jumps to its end (85).
    { type: 'contentGrew', contentHeight: 465 },
    // That jump's scroll event, read a frame later, when the content was already taller: up from where the pin last
    // saw the view (it never scrolled while it fit) and 61px short of the end.
    { type: 'scroll', y: -35, contentHeight: 526, viewportHeight: VIEW, person: false },
    { type: 'contentGrew', contentHeight: 600 },
    { type: 'scroll', y: 600 - VIEW, contentHeight: 600, viewportHeight: VIEW, person: false },
    // The reply keeps streaming: followed, never flagged.
    { type: 'contentGrew', contentHeight: 1600 },
  ], fits);
  expect(state).toMatchObject({ pinned: true, behind: false });
  expect(scrolls).toEqual(['jump', 'none', 'jump', 'none', 'jump']);
});

test('no scroll the person did not make unpins, however far up it lands; the same scroll made by the person does', () => {
  const programmatic: PinEvent = { type: 'scroll', y: 100, contentHeight: 1000, viewportHeight: VIEW, person: false };
  expect(nextPin(pinnedAt(1000), programmatic).state.pinned).toBe(true);
  expect(nextPin(pinnedAt(1000), { ...programmatic, person: true }).state.pinned).toBe(false);
  // Coming back near the end pins again whatever moved the view (focus moved into the thread, say).
  const unpinned: PinState = { pinned: false, lastY: 100, lastHeight: 1000, behind: true };
  expect(nextPin(unpinned, { ...programmatic, y: 480 }).state).toMatchObject({ pinned: true, behind: false });
});
