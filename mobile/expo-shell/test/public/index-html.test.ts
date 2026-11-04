import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { theme } from '../../src/theme';

const pub = join(__dirname, '../../public');
const html = readFileSync(join(pub, 'index.html'), 'utf8');

test('every font URL names a same-origin WOFF2 file in public/fonts', () => {
  const urls = [...html.matchAll(/["'(](\/fonts\/[^"')]+)/g)].map((match) => match[1] ?? '');
  expect(urls).toEqual([
    '/fonts/instrument-sans-v4-latin.woff2',
    '/fonts/instrument-sans-v4-latin.woff2',
    '/fonts/geist-mono-v6-latin.woff2',
  ]);
  for (const url of urls) {
    expect(readFileSync(join(pub, url)).subarray(0, 4).toString('latin1')).toBe('wOF2');
  }
});

test('the @font-face families are the first families theme.ts names', () => {
  const faces = [...html.matchAll(/font-family:\s*'([^']+)'/g)].map((match) => match[1]);
  const first = (stack: string): string => stack.split(',')[0]?.replaceAll('"', '') ?? '';
  expect(faces).toEqual([first(theme.font.sans), first(theme.font.mono)]);
});

test('the page is the ground color before the app paints', () => {
  expect(html).toMatch(new RegExp(`html,\\s*body\\s*\\{\\s*background:\\s*${theme.color.ground};\\s*\\}`));
});
