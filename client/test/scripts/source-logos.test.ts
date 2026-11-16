import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { iconLinks, isPng, largestPngInIco, pngOf } from '../../scripts/source-logos/icons';

// scripts/source-logos (README.md there; source-chips' "A script fetches the logos once" and "Every cited host has a
// name"): the pure helpers on fixture bytes (a PNG is kept, an ICO's largest PNG entry is taken, SVG and BMP are
// refused), the order the page's icon links are tried in, and fetch.mts --check, which fails when a host the shipped
// sources cite has no name in sites.json or logos.ts is not what sites.json and the committed logos make.

const root = join(__dirname, '../..');

const bytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** A PNG's signature and IHDR chunk, enough to be a PNG of `width` by `height` to these helpers. */
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

/** An ICO holding `entries` (each a PNG or a DIB's bytes) in order. */
function ico(entries: readonly { size: number; data: Uint8Array }[]): Uint8Array {
  const directory = 6 + 16 * entries.length;
  const out = new Uint8Array(entries.reduce((sum, entry) => sum + entry.data.length, directory));
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, entries.length, true);
  let offset = directory;
  entries.forEach((entry, index) => {
    const at = 6 + 16 * index;
    view.setUint8(at, entry.size);
    view.setUint8(at + 1, entry.size);
    view.setUint32(at + 8, entry.data.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(entry.data, offset);
    offset += entry.data.length;
  });
  return out;
}

/** A DIB (BMP) icon entry's header: what an old ICO holds instead of a PNG. */
const DIB = new Uint8Array([40, 0, 0, 0, 16, 0, 0, 0, 32, 0, 0, 0, 1, 0, 32, 0]);

test('a PNG is kept as it is', () => {
  const file = png(180, 180);
  expect(isPng(file)).toBe(true);
  expect(pngOf(file)).toBe(file);
});

test('an ICO gives its largest PNG entry; one with only BMP entries gives nothing', () => {
  const small = png(32, 32);
  const large = png(48, 48);
  expect(pngOf(ico([{ size: 16, data: DIB }, { size: 48, data: large }, { size: 32, data: small }]))).toEqual(large);
  expect(largestPngInIco(ico([{ size: 16, data: DIB }, { size: 32, data: DIB }]))).toBeNull();
  // An entry that runs past the file's end is skipped.
  const cut = ico([{ size: 32, data: small }]).subarray(0, 30);
  expect(largestPngInIco(cut)).toBeNull();
});

test('SVG, BMP and anything else are refused', () => {
  expect(pngOf(bytes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle r="8"/></svg>'))).toBeNull();
  expect(pngOf(bytes(`BM${'\u0000'.repeat(60)}`))).toBeNull();
  expect(pngOf(bytes('ÿØÿàJFIF'))).toBeNull();
  expect(pngOf(new Uint8Array())).toBeNull();
});

test('icon links: apple-touch-icons, then PNG icons, then linked ICOs, each largest first, https only', () => {
  const html = `<head>
    <link rel="stylesheet" href="/site.css">
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    <link rel="icon" href="/theme/favicon.ico" type="image/vnd.microsoft.icon">
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
    <link rel='icon' sizes='192x192' href='https://cdn.example.org/icon-192.png?v=1&amp;s=2'>
    <link rel="apple-touch-icon" href="/touch.png">
    <link rel="apple-touch-icon-precomposed" sizes="152x152" href="touch-152.png">
    <link rel="icon" type="image/png" href="http://insecure.example.org/icon.png">
  </head>`;
  expect(iconLinks(html, 'https://www.example.org/home/')).toEqual([
    'https://www.example.org/home/touch-152.png',
    'https://www.example.org/touch.png',
    'https://cdn.example.org/icon-192.png?v=1&s=2',
    'https://www.example.org/favicon-16.png',
    'https://www.example.org/theme/favicon.ico',
  ]);
  expect(iconLinks('<p>No head here</p>', 'https://example.org/')).toEqual([]);
});

test('fetch.mts --check: every host the shipped sources cite has a name, and logos.ts matches sites.json and the logos', () => {
  const result = spawnSync(process.execPath, ['scripts/source-logos/fetch.mts', '--check'], { cwd: root, encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('the manifest matches');
});
