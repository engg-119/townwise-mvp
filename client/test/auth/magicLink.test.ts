import { filterIncomingUrl, parseMagicFragment } from '../../src/auth/magicLink';

const EMAIL = ['a', 'example.com'].join('@');
const token = 'A'.repeat(43);

test('parses token and email from the fragment', () => {
  expect(parseMagicFragment(`token=${token}&email=a%40example.com`)).toEqual({ token, email: EMAIL });
  expect(parseMagicFragment(`#token=${token}&email=a%40example.com`)).toEqual({ token, email: EMAIL });
});

test('parses a fragment with an unrelated leading parameter', () => {
  expect(parseMagicFragment(`a=1&token=${token}&email=a%40example.com`)).toEqual({ token, email: EMAIL });
});

test('URL-decodes the email', () => {
  expect(parseMagicFragment(`token=${token}&email=a%40example.com`)?.email).toBe(EMAIL);
});

test('rejects a token that is not 43 base64url characters', () => {
  expect(parseMagicFragment(`token=${'A'.repeat(42)}&email=a%40example.com`)).toBeNull();
  expect(parseMagicFragment(`token=${'A'.repeat(44)}&email=a%40example.com`)).toBeNull();
  expect(parseMagicFragment(`token=${'A'.repeat(42)}+&email=a%40example.com`)).toBeNull();
});

test('rejects a fragment without an email', () => {
  expect(parseMagicFragment(`token=${token}`)).toBeNull();
  expect(parseMagicFragment(undefined)).toBeNull();
});

test('ignores ?token= in the query', () => {
  expect(parseMagicFragment(`?token=${token}&email=a%40example.com`)).toBeNull();
});

test('filterIncomingUrl keeps the exact https magic URL', () => {
  const url = `https://app.example.com/auth/magic#token=${token}&email=a%40example.com`;
  expect(filterIncomingUrl(url, 'https://app.example.com')).toBe(url);
  expect(filterIncomingUrl(url, 'https://app.example.com/')).toBe(url);
});

test('filterIncomingUrl strips fragments from other hosts and from everything when webUrl is unset', () => {
  const foreign = `https://evil.example/auth/magic#token=${token}`;
  expect(filterIncomingUrl(foreign, 'https://app.example.com')).toBe('https://evil.example/auth/magic');
  const own = `https://app.example.com/auth/magic#token=${token}`;
  expect(filterIncomingUrl(own, undefined)).toBe('https://app.example.com/auth/magic');
});

test('ignores a token delivered via the custom scheme', () => {
  expect(filterIncomingUrl(`kitapp://auth/magic#token=${token}&email=a%40example.com`, 'https://app.example.com')).toBe('kitapp://auth/magic');
});

test('filterIncomingUrl never throws on garbage', () => {
  for (const value of ['', '#', '%%%#x', '\u0000#a']) {
    expect(typeof filterIncomingUrl(value, 'https://app.example.com')).toBe('string');
    expect(typeof filterIncomingUrl(value, undefined)).toBe('string');
  }
});
