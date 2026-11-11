import { focusLost } from '../../src/chat/ui/controls';

// focusLost() reads the page's focus, which iOS and Android don't have: there it answers false (nothing to put
// back) instead of throwing, whichever caller forgets to check the platform first.

test('focusLost answers false on native, where there is no document', () => {
  expect(typeof document).toBe('undefined');
  expect(focusLost()).toBe(false);
});
