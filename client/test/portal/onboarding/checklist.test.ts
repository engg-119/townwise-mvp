import { CHECKLIST_COPY, checklistStatus, MAX_CHECKED_PLACES, outsideUsLine } from '../../../src/portal/onboarding/checklist';
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
