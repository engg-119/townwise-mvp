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
  const pinned = run([{ type: 'contentGrew', contentHeight: 1000 }, { type: 'scroll', y: 500, contentHeight: 1000, viewportHeight: VIEW }]).state;
  expect(run([{ type: 'scroll', y: 497, contentHeight: 1000, viewportHeight: VIEW }], pinned).state.pinned).toBe(true);
  const { state, scrolls } = run([
    { type: 'scroll', y: 480, contentHeight: 1000, viewportHeight: VIEW },
    { type: 'contentGrew', contentHeight: 1200 },
  ], pinned);
  expect(state).toMatchObject({ pinned: false, behind: true });
  expect(scrolls).toEqual(['none', 'none']);
});

test('coming back down to within 40px of the end pins again and hides Latest', () => {
  const unpinned: PinState = { pinned: false, lastY: 300, lastHeight: 1200, behind: true };
  expect(run([{ type: 'scroll', y: 600, contentHeight: 1200, viewportHeight: VIEW }], unpinned).state.pinned).toBe(false);
  expect(run([{ type: 'scroll', y: 665, contentHeight: 1200, viewportHeight: VIEW }], unpinned).state).toMatchObject({ pinned: true, behind: false });
});

test('content that shrank (a tool group folding) is not the person scrolling: the pin stays', () => {
  const pinned: PinState = { pinned: true, lastY: 700, lastHeight: 1200, behind: false };
  const { state, scrolls } = run([{ type: 'scroll', y: 500, contentHeight: 1000, viewportHeight: VIEW }], pinned);
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
    frames.push({ type: 'contentGrew', contentHeight: height }, { type: 'scroll', y: height - VIEW, contentHeight: height, viewportHeight: VIEW });
  }
  const { state, scrolls } = run(frames, pinnedAt(1000));
  expect(state).toMatchObject({ pinned: true, behind: false, lastHeight: 1240 });
  expect(scrolls.filter((_, index) => index % 2 === 0).every((scroll) => scroll === 'jump')).toBe(true);
  // A scroll event that arrives before the jump lands (the content grew under the view) is no scroll up.
  expect(run([{ type: 'scroll', y: 500, contentHeight: 1100, viewportHeight: VIEW }, { type: 'contentGrew', contentHeight: 1100 }], pinnedAt(1000)).scrolls)
    .toEqual(['none', 'jump']);
});

test('content shrinking under a pinned view keeps the pin, even when the new height is heard before the scroll it caused', () => {
  // The timeline closes: each frame the height is heard first, then the browser's pull of the offset to the new end.
  const frames: PinEvent[] = [];
  for (let height = 1180; height >= 1000; height -= 20) {
    frames.push({ type: 'contentGrew', contentHeight: height }, { type: 'scroll', y: height - VIEW, contentHeight: height, viewportHeight: VIEW });
  }
  const closed = run(frames, pinnedAt(1200)).state;
  expect(closed).toMatchObject({ pinned: true, behind: false });
  // So the reply growing after it is followed, not flagged.
  expect(nextPin(closed, { type: 'contentGrew', contentHeight: 1300 })).toMatchObject({ state: { pinned: true, behind: false }, scroll: 'jump' });
});

test('an iOS bounce at the end is no scroll up', () => {
  const { state } = run([
    { type: 'scroll', y: 560, contentHeight: 1000, viewportHeight: VIEW },
    { type: 'scroll', y: 520, contentHeight: 1000, viewportHeight: VIEW },
    { type: 'scroll', y: 500, contentHeight: 1000, viewportHeight: VIEW },
  ], pinnedAt(1000));
  expect(state.pinned).toBe(true);
});

test('a scroll up stops the following, even a slow one a few pixels at a time; nothing moves the view until the person comes back', () => {
  const slow = run([
    { type: 'scroll', y: 498, contentHeight: 1000, viewportHeight: VIEW },
    { type: 'scroll', y: 496, contentHeight: 1000, viewportHeight: VIEW },
    { type: 'scroll', y: 494, contentHeight: 1000, viewportHeight: VIEW },
  ], pinnedAt(1000));
  expect(slow.state.pinned).toBe(false);
  // The reply keeps streaming, the timeline opens and closes: the view stays where the person left it.
  const { state, scrolls } = run([
    { type: 'contentGrew', contentHeight: 1100 },
    { type: 'contentGrew', contentHeight: 1300 },
    { type: 'contentGrew', contentHeight: 1250 },
    { type: 'scroll', y: 494, contentHeight: 1250, viewportHeight: VIEW },
  ], slow.state);
  expect(scrolls).toEqual(['none', 'none', 'none', 'none']);
  expect(state).toMatchObject({ pinned: false, behind: true });
  // Back down near the end: pinned again, and the next growth is followed.
  const back = nextPin(state, { type: 'scroll', y: 720, contentHeight: 1250, viewportHeight: VIEW }).state;
  expect(back).toMatchObject({ pinned: true, behind: false });
  expect(nextPin(back, { type: 'contentGrew', contentHeight: 1400 }).scroll).toBe('jump');
  // A new prompt always goes to the end.
  expect(nextPin(state, { type: 'send' })).toMatchObject({ state: { pinned: true }, scroll: 'move' });
});
