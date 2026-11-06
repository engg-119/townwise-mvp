import { requestReceivedStatement, spokenStatement, welcomeStatement } from '../../../src/portal/moments/moments';

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
    expect(line).not.toContain('—');
  }
  expect(requestReceivedStatement('Hanover Inn').lead).toContain('’');
});

test('a screen reader hears the whole statement as one sentence pair', () => {
  expect(spokenStatement(requestReceivedStatement('Hanover Inn'))).toBe('We’ve received your request for Hanover Inn. We’ll let you in soon.');
});
