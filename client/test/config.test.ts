import { ConfigError, parseConfig } from '../src/config';

const WEB_ID = '123-abc.apps.googleusercontent.com';
const IOS_ID = '456-def.apps.googleusercontent.com';

test('rejects http outside dev and accepts it in dev', () => {
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: 'http://localhost:3000' }, { dev: false })).toThrow(ConfigError);
  expect(parseConfig({ EXPO_PUBLIC_API_URL: 'http://localhost:3000' }, { dev: true }).apiUrl).toBe('http://localhost:3000');
});

test('strips trailing slashes, and empty string means unset', () => {
  expect(parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com/api//' }, { dev: false }).apiUrl).toBe('https://api.example.com/api');
  expect(parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com', EXPO_PUBLIC_WEB_URL: '' }, { dev: false }).webUrl).toBeNull();
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: '' }, { dev: false })).toThrow(ConfigError);
});

test('rejects query, fragment and userinfo in apiUrl and accepts a path prefix', () => {
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com?a=1' }, { dev: false })).toThrow(ConfigError);
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com#x' }, { dev: false })).toThrow(ConfigError);
  const userinfo = ['https://u:p', 'api.example.com'].join('@');
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: userinfo }, { dev: false })).toThrow(ConfigError);
  expect(parseConfig({ EXPO_PUBLIC_API_URL: 'https://app.example.com/api' }, { dev: false }).apiUrl).toBe('https://app.example.com/api');
});

test('webUrl must be a bare origin', () => {
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com', EXPO_PUBLIC_WEB_URL: 'https://app.example.com/x' }, { dev: false })).toThrow(ConfigError);
  expect(parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com', EXPO_PUBLIC_WEB_URL: 'https://app.example.com' }, { dev: false }).webUrl).toBe('https://app.example.com');
});

test('an iOS ID without a web ID is an error, and malformed Google IDs are rejected', () => {
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com', EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: IOS_ID }, { dev: false })).toThrow(ConfigError);
  expect(() => parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com', EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: 'abc.apps.googleusercontent.com' }, { dev: false })).toThrow(ConfigError);
  expect(parseConfig({
    EXPO_PUBLIC_API_URL: 'https://api.example.com',
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: WEB_ID,
    EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: IOS_ID,
  }, { dev: false }).google).toEqual({ webClientId: WEB_ID, iosClientId: IOS_ID });
  expect(parseConfig({
    EXPO_PUBLIC_API_URL: 'https://api.example.com',
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: WEB_ID,
  }, { dev: false }).google).toEqual({ webClientId: WEB_ID, iosClientId: null });
  expect(parseConfig({ EXPO_PUBLIC_API_URL: 'https://api.example.com' }, { dev: false }).google).toBeNull();
});

test('the error message names the variable and not the value', () => {
  try {
    parseConfig({ EXPO_PUBLIC_API_URL: 'ftp://secret-host.example' }, { dev: false });
    throw new Error('expected ConfigError');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('EXPO_PUBLIC_API_URL');
    expect(message).not.toContain('secret-host');
  }
});
