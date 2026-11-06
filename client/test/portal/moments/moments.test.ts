import { momentFor, requestReceivedStatement, spokenStatement, welcomeStatement } from '../../../src/portal/moments/moments';
import type { MeResponse } from '../../../src/portal/schemas';
import { ACCESS, meOf, staffMe, viewAsMe } from '../../helpers/portal';

const STRAIGHT_QUOTE = '\'';

test('request received names the request and says only what is true now', () => {
  expect(requestReceivedStatement('Hanover Inn')).toEqual({
    lead: 'We’ve received your request for Hanover Inn.',
    follow: 'We’ll let you in soon.',
  });
});

test.each(['Lou’s Inc.', 'Is This Open?', 'Wow!'])('a name that already ends a sentence gets no second stop (%s)', (name) => {
  expect(requestReceivedStatement(name).lead).toBe(`We’ve received your request for ${name}`);
});

test('the welcome greets by first name and names the restaurant', () => {
  expect(welcomeStatement({ firstName: 'Sam', restaurant: 'Hanover Inn' })).toEqual({
    lead: 'Welcome to Townwise, Sam.',
    follow: 'Hanover Inn, ready to set up.',
  });
});

test.each([null, '', '  '])('with no usable first name the welcome has no name (%j)', (firstName) => {
  expect(welcomeStatement({ firstName, restaurant: 'Hanover Inn' })).toEqual({
    lead: 'Welcome to Townwise.',
    follow: 'Hanover Inn, ready to set up.',
  });
});

test('our copy uses U+2019 apostrophes, no exclamation marks and no em dashes', () => {
  const lines = [
    requestReceivedStatement('Hanover Inn'), welcomeStatement({ firstName: 'Sam', restaurant: 'Hanover Inn' }),
    welcomeStatement({ firstName: null, restaurant: 'Hanover Inn' }),
  ].flatMap((statement) => [statement.lead, statement.follow]);
  for (const line of lines) {
    expect(line).not.toContain(STRAIGHT_QUOTE);
    expect(line).not.toContain('!');
    expect(line).not.toContain('\u2014');
  }
  expect(requestReceivedStatement('Hanover Inn').lead).toContain('’');
});

test('a screen reader hears the whole statement as one sentence pair', () => {
  expect(spokenStatement(requestReceivedStatement('Hanover Inn'))).toBe('We’ve received your request for Hanover Inn. We’ll let you in soon.');
});

describe('momentFor', () => {
  const NONE: ReadonlySet<string> = new Set();
  const PENDING = meOf(ACCESS.pending);
  const WELCOME = { firstName: 'Pat', restaurant: 'Sample Mountain Tavern' };
  const WELCOMED = meOf(ACCESS.admin, { welcome: WELCOME });

  test.each([
    ['no_org', meOf(ACCESS.noOrg)], ['rejected', meOf(ACCESS.rejected)], ['removed', meOf(ACCESS.removed)],
  ])('%s to pending plays request received for that request', (_state, previous) => {
    expect(momentFor(previous, PENDING, NONE)).toEqual({
      key: 'received:r1', kind: 'request_received', statement: requestReceivedStatement('Sample Mountain Tavern'),
    });
  });

  test.each<[string, MeResponse | null]>([
    ['a fresh load (no previous answer)', null],
    ['invited (a decline that returns to Waiting)', meOf(ACCESS.invited)],
    ['pending (Check again)', PENDING],
    ['a member', meOf(ACCESS.member)],
  ])('pending after %s plays nothing', (_case, previous) => {
    expect(momentFor(previous, PENDING, NONE)).toBeNull();
  });

  test('a request already played does not replay; a new request after a rejection does', () => {
    const played = new Set(['received:r1']);
    expect(momentFor(meOf(ACCESS.noOrg), PENDING, played)).toBeNull();
    const again = meOf({ state: 'pending', request: { ...ACCESS.pending.request, id: 'r2' } });
    expect(momentFor(meOf(ACCESS.rejected), again, played)?.key).toBe('received:r2');
  });

  test('the welcome plays only for a member whose answer carries it, keyed by person and organization', () => {
    expect(momentFor(null, WELCOMED, NONE)).toEqual({
      key: 'welcome:u1:o1', kind: 'welcome', statement: welcomeStatement(WELCOME),
    });
    expect(momentFor(WELCOMED, WELCOMED, NONE)?.kind).toBe('welcome');
    expect(momentFor(null, meOf(ACCESS.admin), NONE)).toBeNull();
    expect(momentFor(null, meOf(ACCESS.admin, { welcome: null }), NONE)).toBeNull();
    expect(momentFor(null, WELCOMED, new Set(['welcome:u1:o1']))).toBeNull();
    // A welcome on any other access is ignored (the server never sends one there).
    expect(momentFor(null, meOf(ACCESS.noOrg, { welcome: WELCOME }), NONE)).toBeNull();
  });

  test('under view-as nothing plays, whatever the answer carries', () => {
    expect(momentFor(staffMe(), viewAsMe(ACCESS.pending), NONE)).toBeNull();
    expect(momentFor(viewAsMe(ACCESS.noOrg), viewAsMe(ACCESS.pending), NONE)).toBeNull();
    expect(momentFor(null, { ...viewAsMe(ACCESS.admin), welcome: WELCOME }, NONE)).toBeNull();
    // Nor right after it: the previous answer was the target's, not the person's own.
    expect(momentFor(viewAsMe(ACCESS.noOrg), PENDING, NONE)).toBeNull();
  });
});
