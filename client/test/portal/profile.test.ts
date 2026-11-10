import { greeting, nameProblem, NAME_MESSAGE } from '../../src/portal/profile/greeting';

it('greets without a doubled full stop, and without a name', () => {
  expect(greeting('Cam')).toBe('Welcome back, Cam.');
  expect(greeting('St.')).toBe('Welcome back, St.');
  expect(greeting(null)).toBe('Welcome back.');
});

it('flags what the API refuses with one message', () => {
  expect(nameProblem('Cam2')).toBe(NAME_MESSAGE);
  expect(nameProblem('שרה')).toBeNull();
  expect(nameProblem('Mary-Jane O’Neil')).toBeNull();
  expect(nameProblem('a'.repeat(41))).toBe(NAME_MESSAGE);
  expect(nameProblem('<b>')).toBe(NAME_MESSAGE);
  expect(nameProblem('   ')).toBeNull();
});
