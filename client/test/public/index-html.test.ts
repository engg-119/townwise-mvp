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

// Each <meta> or <link> tag's attributes; boolean attributes (crossorigin) are left out.
function tags(name: 'meta' | 'link'): Record<string, string | undefined>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((match) =>
    Object.fromEntries([...(match[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)].map((attr) => [attr[1] ?? '', attr[2]])));
}

function meta(key: string): string | undefined {
  return tags('meta').find((tag) => tag.property === key || tag.name === key)?.content;
}

// A PNG's size from its IHDR chunk, and whether it can be transparent (an alpha channel or a tRNS chunk).
function png(bytes: Buffer): { width: number; height: number; transparent: boolean } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR');
  const colorType = bytes[25];
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), transparent: colorType === 4 || colorType === 6 || bytes.includes('tRNS') };
}

const IMAGE = 'https://townwise.tech/og/townwise.png';
const IMAGE_ALT = 'The word Townwise and the line “Forecasts of daily guests and sales for restaurants and bars, from your town’s calendar.” above a dark map of the northeastern United States, with towns marked by mint dots.';

test('the share tags give the image, its size, type and alt text, and repeat the page for X', () => {
  expect({
    locale: meta('og:locale'),
    image: meta('og:image'),
    width: meta('og:image:width'),
    height: meta('og:image:height'),
    type: meta('og:image:type'),
    alt: meta('og:image:alt'),
    card: meta('twitter:card'),
    xTitle: meta('twitter:title'),
    xDescription: meta('twitter:description'),
    xImage: meta('twitter:image'),
    xAlt: meta('twitter:image:alt'),
    themeColor: meta('theme-color'),
    appTitle: meta('apple-mobile-web-app-title'),
  }).toEqual({
    locale: 'en_US',
    image: IMAGE,
    width: '1200',
    height: '630',
    type: 'image/png',
    alt: IMAGE_ALT,
    card: 'summary_large_image',
    xTitle: meta('og:title'),
    xDescription: meta('og:description'),
    xImage: IMAGE,
    xAlt: IMAGE_ALT,
    themeColor: theme.color.ground,
    appTitle: 'Townwise',
  });
  expect(meta('og:title')).toBe('Townwise');
  expect(meta('og:description')).toBe(meta('description'));
  expect(html).not.toContain('—');
});

test('the share image is in public/ at the size the tags give, under 300 KB', () => {
  const bytes = readFileSync(join(pub, new URL(IMAGE).pathname));
  expect(png(bytes)).toMatchObject({ width: 1200, height: 630 });
  expect(bytes.length).toBeLessThan(300 * 1024);
});

test('every icon link names a file in public/ at its stated size', () => {
  const icons = tags('link').filter((tag) => tag.rel === 'icon' || tag.rel === 'apple-touch-icon')
    .map((tag) => ({ rel: tag.rel, href: tag.href, type: tag.type, sizes: tag.sizes }));
  expect(icons).toEqual([
    { rel: 'icon', href: '/favicon.ico', type: undefined, sizes: '32x32' },
    { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
    { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml', sizes: undefined },
    { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', type: undefined, sizes: undefined },
  ]);

  expect(png(readFileSync(join(pub, 'favicon-32.png')))).toMatchObject({ width: 32, height: 32 });
  // iOS draws the touch icon on black where it is transparent, so it has none: 180 by 180 on the ground color.
  expect(png(readFileSync(join(pub, 'apple-touch-icon.png')))).toEqual({ width: 180, height: 180, transparent: false });

  const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
  expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);

  // ICO: a 6-byte header (reserved 0, type 1, count), 16-byte entries, each pointing at a PNG of its size.
  const ico = readFileSync(join(pub, 'favicon.ico'));
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
  const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const at = 6 + 16 * index;
    const size = ico[at] ?? -1;
    const image = png(ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8)));
    return { size, image: [image.width, image.height] };
  });
  expect(entries).toEqual([16, 32, 48].map((size) => ({ size, image: [size, size] })));
});
