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
