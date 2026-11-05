// Renders the link-preview image and the icons in public/ with a headless Chromium (README.md here):
// - og.html, with the homepage map's own state outlines and town markers, to public/og/townwise.png;
// - public/favicon.svg to public/favicon-32.png, public/favicon.ico (16, 32 and 48 px PNG entries) and
//   public/apple-touch-icon.png (180 px on the ground color, no transparency).
// Playwright is not a dependency of this repo: pass the path of a Playwright package installed elsewhere.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type * as Geometry from '../../src/marketing/map/geometry';

interface Page {
  goto: (url: string) => Promise<unknown>;
  setContent: (html: string) => Promise<void>;
  evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;
  screenshot: (options: { type: 'png'; omitBackground?: boolean }) => Promise<Buffer>;
}
interface Browser {
  newPage: (options: { viewport: { width: number; height: number }; deviceScaleFactor: number }) => Promise<Page>;
  close: () => Promise<void>;
}
interface Playwright {
  chromium: { launch: () => Promise<Browser> };
}

const GROUND = '#080a0d'; // theme.color.ground
const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, '../../public');

const playwrightPath = process.argv[2];
if (playwrightPath === undefined) {
  console.error('usage: node client/scripts/share-images/render.mts <path to node_modules/playwright>');
  process.exit(1);
}
const { chromium } = createRequire(import.meta.url)(resolve(playwrightPath)) as Playwright;
const geometry = (await import(pathToFileURL(resolve(here, '../../src/marketing/map/geometry.ts')).href)) as typeof Geometry;

// A map point as a position in the overlay, in percent of the viewBox, as NortheastMap.web.tsx places it.
function place([x, y]: Geometry.Point): [left: number, top: number] {
  return [(x * 100) / geometry.VIEW_WIDTH, (y * 100) / geometry.VIEW_HEIGHT];
}

// The overlay items: one marker per town, then the state abbreviations. Items within EDGE px of the
// image's edges are dropped, so nothing is cut off or crowds the edge.
const EDGE = 32;
const items = [
  ...geometry.townShapes.map((town) => ({ className: 'dot', text: '', at: place(town.centroid) })),
  ...geometry.stateShapes.map((state) => ({ className: 'st', text: state.abbr, at: place(state.label) })),
];

async function renderShareImage(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(here, 'og.html')).href);
  const { faces, kept } = await page.evaluate(async ({ statesD, overlay, edge }) => {
    document.querySelector('.states')?.setAttribute('d', statesD);
    const ov = document.querySelector('.ov');
    for (const { className, text, at: [left, top] } of overlay) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      span.style.left = `${String(left)}%`;
      span.style.top = `${String(top)}%`;
      ov?.append(span);
    }
    await document.fonts.ready;
    document.querySelectorAll('.ov > span').forEach((span) => {
      const box = span.getBoundingClientRect();
      if (box.left < edge || box.top < edge || box.right > innerWidth - edge || box.bottom > innerHeight - edge) span.remove();
    });
    const list: string[] = [];
    document.fonts.forEach((face) => { list.push(`${face.family} ${face.status}`); });
    return { faces: list, kept: document.querySelectorAll('.ov > .dot').length };
  }, { statesD: geometry.STATES_D, overlay: items, edge: EDGE });
  // Never ship a render in a fallback face: every declared face must be used and loaded.
  if (faces.length === 0 || faces.some((face) => !face.endsWith(' loaded'))) {
    throw new Error(`og.html fonts did not all load: ${faces.join(', ')}`);
  }
  console.log(`og.html: ${String(kept)} of ${String(geometry.townShapes.length)} town markers inside the frame`);
  return page.screenshot({ type: 'png' });
}

// The favicon drawn at `size` px, centered on a `canvas` px square: transparent around it, or the ground color.
async function renderIcon(browser: Browser, svg: string, size: number, canvas: number, ground: boolean): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: canvas, height: canvas }, deviceScaleFactor: 1 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const background = ground ? GROUND : 'transparent';
  await page.setContent(`<style>html,body{margin:0;height:100%;background:${background}}body{display:grid;place-items:center}img{display:block}</style><img src="${src}" width="${String(size)}" height="${String(size)}" alt="">`);
  return page.screenshot({ type: 'png', omitBackground: !ground });
}

// An ICO file whose entries are PNG images (supported by every current browser).
function ico(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

const browser = await chromium.launch();
try {
  mkdirSync(join(pub, 'og'), { recursive: true });
  writeFileSync(join(pub, 'og/townwise.png'), await renderShareImage(browser));

  const svg = readFileSync(join(pub, 'favicon.svg'), 'utf8');
  const sizes = [16, 32, 48];
  const pngs = await Promise.all(sizes.map((size) => renderIcon(browser, svg, size, size, false)));
  writeFileSync(join(pub, 'favicon-32.png'), pngs[1] ?? Buffer.alloc(0));
  writeFileSync(join(pub, 'favicon.ico'), ico(sizes.map((size, index) => ({ size, png: pngs[index] ?? Buffer.alloc(0) }))));
  writeFileSync(join(pub, 'apple-touch-icon.png'), await renderIcon(browser, svg, 128, 180, true));
} finally {
  await browser.close();
}
console.log('wrote public/og/townwise.png, favicon-32.png, favicon.ico and apple-touch-icon.png');
