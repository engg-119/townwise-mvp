import { cleanup, render, screen } from '@testing-library/react';

import { ChatButton } from '../../src/chat/ui/controls';

// The round arrow (the composer's Expand and Shrink) is a 44px circle, so its hover fill stays inside the composer's
// rounded corner; a plain arrow stays square.

afterEach(cleanup);

test('a round arrow is a 44px circle and a plain arrow is not', () => {
  render(
    <>
      <ChatButton variant="arrow" round label="Round" onPress={() => undefined} />
      <ChatButton variant="arrow" label="Plain" onPress={() => undefined} />
    </>,
  );
  const round = getComputedStyle(screen.getByRole('button', { name: 'Round' }));
  expect(round.getPropertyValue('border-top-left-radius')).toBe('22px');
  expect(round.getPropertyValue('width')).toBe('44px');
  expect(getComputedStyle(screen.getByRole('button', { name: 'Plain' })).getPropertyValue('border-top-left-radius')).not.toBe('22px');
});

test('round is for arrows only: another variant keeps its size', () => {
  render(<ChatButton variant="outline" round label="Save and send" onPress={() => undefined} />);
  expect(getComputedStyle(screen.getByRole('button', { name: 'Save and send' })).getPropertyValue('width')).not.toBe('44px');
});
