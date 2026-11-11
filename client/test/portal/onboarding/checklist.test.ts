import { addLabel, CHECKLIST_COPY, checklistStatus, continueLabel, locationCountFor, MAX_CHECKED_PLACES, outsideUsLine } from '../../../src/portal/onboarding/checklist';
import { SUGGESTIONS } from './places-fakes';

// The checklist's words (onboarding/checklist.ts): the status line counts the answer and asks for each place that's
// the person's, a place outside a US town says why by name, and the limit is the organization's 25 locations.

test('the status line: nothing before an answer, then no match, one place or several', () => {
  const [first] = SUGGESTIONS;
  if (first === undefined) throw new Error('fixture');
  expect(checklistStatus({ searched: null, suggestions: [] })).toBeNull();
  expect(checklistStatus({ searched: 'Zz', suggestions: [] })).toBe('No places match “Zz”. Check the spelling, or enter it yourself.');
  expect(checklistStatus({ searched: 'Lou', suggestions: [first] })).toBe('1 place matches “Lou”. Check each one that’s yours.');
  expect(checklistStatus({ searched: 'Lou', suggestions: SUGGESTIONS })).toBe('3 places match “Lou”. Check each one that’s yours.');
});

test('a place outside a US town is named with the town line’s reason; the limit and a lost place say so', () => {
  expect(outsideUsLine('Lou’s Cantina')).toBe('Lou’s Cantina: Townwise works with businesses in a US town, and Google Maps puts this place in none.');
  expect(MAX_CHECKED_PLACES).toBe(25);
  expect(CHECKLIST_COPY).toEqual({
    limit: 'You can add up to 25 places.',
    gone: 'Google Maps can’t find that place any more. Search again, or enter it yourself.',
  });
});

test('the count never falls below the checked places, and keeps what was typed when nothing is checked', () => {
  expect(locationCountFor('', 0)).toBe('');
  expect(locationCountFor('', 3)).toBe('3');
  expect(locationCountFor('2', 3)).toBe('3');
  expect(locationCountFor('5', 3)).toBe('5');
  expect(locationCountFor('5', 0)).toBe('5');
  expect(locationCountFor('x', 2)).toBe('2');
});

test('Continue names how many places it carries on', () => {
  expect(continueLabel(0)).toBe('Continue');
  expect(continueLabel(1)).toBe('Continue with 1 place');
  expect(continueLabel(2)).toBe('Continue with 2 places');
});

test('Add location names how many locations it adds, past one', () => {
  expect(addLabel(0)).toBe('Add location');
  expect(addLabel(1)).toBe('Add location');
  expect(addLabel(3)).toBe('Add 3 locations');
});
