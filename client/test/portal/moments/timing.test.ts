import { requestReceivedStatement, welcomeStatement } from '../../../src/portal/moments/moments';
import {
  EXIT_MS, FADE_MS, HOLD_MS, LINE_RHYTHM_MS, PUNCT_HOLD_MS, REDUCED_HOLD_MS, START_MS, timeline, wordDelays, wordsOf,
} from '../../../src/portal/moments/timing';

const SIXTY = 'The Very Long Named Restaurant and Bar of Upper Valley Hills';

test('a 60-character name fixture is 60 characters', () => {
  expect(SIXTY).toHaveLength(60);
});

test('words split on any whitespace and keep their punctuation', () => {
  expect(wordsOf('  Welcome to\tTownwise,  Sam. ')).toEqual(['Welcome', 'to', 'Townwise,', 'Sam.']);
});

test('the stagger is 80ms until a line would take longer than 640ms, then it shrinks to fit', () => {
  expect(wordDelays(['a', 'b', 'c'])).toEqual([0, 80, 160]);
  expect(wordDelays(Array.from({ length: 9 }, () => 'w')).at(-1)).toBe(640);
  const fifteen = wordDelays(Array.from({ length: 15 }, () => 'w'));
  expect(fifteen[1]).toBe(Math.floor(LINE_RHYTHM_MS / 14));
  expect(fifteen.at(-1)).toBeLessThanOrEqual(LINE_RHYTHM_MS);
  expect(wordDelays(['only'])).toEqual([0]);
});

test('a clause or a sentence inside a line holds 140ms; the line’s own last stop does not', () => {
  expect(wordDelays(['Welcome', 'to', 'Townwise,', 'Sam.'])).toEqual([0, 80, 160, 240 + PUNCT_HOLD_MS]);
  expect(wordDelays(['Done.', 'Next'])).toEqual([0, 80 + PUNCT_HOLD_MS]);
  expect(wordDelays(['a;', 'b:', 'c'])).toEqual([0, 80 + PUNCT_HOLD_MS, 160 + 2 * PUNCT_HOLD_MS]);
});

test('at most two holds in a line, so a name full of commas can’t stretch it', () => {
  const delays = wordDelays(['a,', 'b,', 'c,', 'd,', 'e']);
  expect(delays).toEqual([0, 80 + PUNCT_HOLD_MS, 160 + 2 * PUNCT_HOLD_MS, 240 + 2 * PUNCT_HOLD_MS, 320 + 2 * PUNCT_HOLD_MS]);
});

test('request received for Hanover Inn: the lead lands at 800ms, the follow at 1680ms, gone at 3280ms', () => {
  const plan = timeline(requestReceivedStatement('Hanover Inn'), false);
  expect(plan.lead[0]).toBe(START_MS);
  expect((plan.lead.at(-1) ?? 0) + FADE_MS).toBe(800);
  expect(plan.follow[0]).toBe(1160);
  expect(plan.revealEndMs).toBe(1680);
  expect(plan.exitAtMs).toBe(1680 + HOLD_MS);
  expect(plan.exitAtMs).toBe(3080);
  expect(plan.doneAtMs).toBe(3280);
  expect(plan.fadeMs).toBe(FADE_MS);
  expect(plan.exitMs).toBe(EXIT_MS);
});

test('welcome Sam to Hanover Inn: the lead lands at 700ms, the follow at 1800ms, gone at 3400ms', () => {
  const plan = timeline(welcomeStatement({ firstName: 'Sam', restaurant: 'Hanover Inn' }), false);
  expect(plan.lead).toEqual([120, 200, 280, 500]);
  expect((plan.lead.at(-1) ?? 0) + FADE_MS).toBe(700);
  expect(plan.follow).toEqual([1060, 1140, 1360, 1440, 1520, 1600]);
  expect(plan.revealEndMs).toBe(1800);
  expect(plan.exitAtMs).toBe(3200);
  expect(plan.doneAtMs).toBe(3400);
});

test('every moment ends within 5 seconds, even with a 60-character name', () => {
  const statements = [
    requestReceivedStatement(SIXTY), welcomeStatement({ firstName: 'Sam', restaurant: SIXTY }),
    welcomeStatement({ firstName: null, restaurant: SIXTY }),
    requestReceivedStatement('A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X'),
    welcomeStatement({ firstName: 'Sam', restaurant: 'A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T' }),
  ];
  for (const statement of statements) {
    const plan = timeline(statement, false);
    expect(plan.doneAtMs).toBeLessThan(5000);
  }
  expect(timeline(requestReceivedStatement(SIXTY), false).doneAtMs).toBeLessThan(4200);
  expect(timeline(welcomeStatement({ firstName: 'Sam', restaurant: SIXTY }), false).doneAtMs).toBeLessThan(4200);
});

test('reduced motion: both lines whole at 0, no fades, still for 2400ms, then gone at once', () => {
  const plan = timeline(welcomeStatement({ firstName: 'Sam', restaurant: 'Hanover Inn' }), true);
  expect(plan.lead).toEqual([0, 0, 0, 0]);
  expect(plan.follow).toEqual([0, 0, 0, 0, 0, 0]);
  expect(plan.fadeMs).toBe(0);
  expect(plan.revealEndMs).toBe(0);
  expect(plan.exitAtMs).toBe(REDUCED_HOLD_MS);
  expect(plan.exitMs).toBe(0);
  expect(plan.doneAtMs).toBe(2400);
});
