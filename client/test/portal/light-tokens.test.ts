import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { theme } from '../../src/theme';

// The light-mode polish: the modal scrim and the list shadow are palette tokens, the heat levels and the town chart's
// series follow the palette, and the browser's own controls take the palette's color-scheme. Dark stays as it was.

const src = join(__dirname, '../../src');
const read = (path: string): string => readFileSync(join(src, path), 'utf8');
const html = readFileSync(join(__dirname, '../../public/index.html'), 'utf8');

function luminance(hex: string): number {
  const linear = (at: number): number => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test('scrim and shadow: dark is the old hardcoded value, light is a softer dim', () => {
  expect(theme.palette.dark.scrim).toBe('rgba(8, 10, 13, 0.8)');
  expect(theme.palette.dark.shadow).toBe('rgba(0, 0, 0, 0.6)');
  expect(theme.palette.light.scrim).toBe('rgba(13, 16, 20, 0.4)');
  expect(theme.palette.light.shadow).toBe('rgba(13, 16, 20, 0.18)');
});

test.each([
  'portal/ui/ConfirmDialog.tsx', 'portal/ui/Select.tsx', 'portal/console/Dialog.tsx', 'chat/ui/ModelCardSheet.tsx',
])('%s backdrop is the scrim token, not a literal', (file) => {
  const code = read(file);
  expect(code).toContain('backgroundColor: c.scrim');
  expect(code).not.toMatch(/rgba\(8, 10, 13/);
});

test('the Select listbox shadow is the shadow token', () => {
  const code = read('portal/ui/Select.web.tsx');
  expect(code).toContain('boxShadow: `0 12px 32px ${c.shadow}`');
  expect(code).not.toContain('rgba(0, 0, 0, 0.6)');
});

test('heat levels are the palette mint at the old alpha, as a percent, with no hardcoded channels', () => {
  const code = read('portal/analytics/Heatmap.web.tsx');
  expect(code).toContain('const LEVEL_PERCENT = [0, 25, 45, 70, 100] as const;');
  expect(code).toContain('color-mix(in srgb, ${C.mint} ${String(percent)}%, transparent)');
  expect(code).not.toContain('123, 210, 180');
  expect(code).not.toMatch(/rgba\(\$\{/);
});

test('the town chart draws its series with the series tokens', () => {
  const code = read('portal/town/TownChart.web.tsx');
  expect(code).toContain('stroke={C.seriesNortheast} strokeWidth={1.5}');
  expect(code).toContain('stroke={C.seriesCounty} strokeWidth={2}');
  expect(code).toContain('2px dashed ${C.seriesNortheast}');
  expect(code).toContain('2px solid ${C.seriesCounty}');
  expect(code).not.toContain('stroke={C.text3}');
});

test('light: the Northeast line is told apart from the county line by luminance as well as its dash', () => {
  const { light } = theme.palette;
  expect(contrast(light.seriesNortheast, light.seriesCounty)).toBeGreaterThanOrEqual(1.5);
  for (const surface of [light.ground, light.panel, light.raised]) {
    expect(contrast(light.seriesNortheast, surface)).toBeGreaterThanOrEqual(3);
  }
});

test('iframes stay color-scheme normal so Google\'s sign-in frame is not painted opaque', () => {
  expect(html).toMatch(/\biframe\s*\{\s*color-scheme:\s*normal;\s*\}/);
});

test('color-scheme follows the palette: the root takes --tw-scheme and the date input reads it', () => {
  expect(html).toMatch(/\bhtml\s*\{\s*color-scheme:\s*var\(--tw-scheme\);\s*\}/);
  const field = read('portal/locations/DateField.web.tsx');
  expect(field).toContain("colorScheme: 'var(--tw-scheme)'");
  expect(field).not.toContain("colorScheme: 'dark'");
});
