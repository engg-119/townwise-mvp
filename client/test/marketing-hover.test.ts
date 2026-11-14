import { homeCss } from '../src/marketing/homeStyles.web';
import { mapCss } from '../src/marketing/map/mapStyles.web';
import { css } from '../src/marketing/styles.web';

// A tap on a touch screen leaves :hover stuck, so every :hover rule sits inside @media (hover:hover).

/** Each top-level rule or at-rule block of a stylesheet, as written (no nested braces beyond two levels). */
function topLevel(sheet: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sheet.length; i += 1) {
    const ch = sheet[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { out.push(sheet.slice(start, i + 1).trim()); start = i + 1; }
    }
  }
  return out;
}

test.each([['home', homeCss], ['pages', css], ['map', mapCss]])('%s: every rule that mentions :hover is inside @media (hover:hover)', (_name, sheet) => {
  const blocks = topLevel(sheet).filter((block) => block.includes(':hover'));
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) expect(block.startsWith('@media (hover:hover)')).toBe(true);
});

test('the map keeps its pointer-driven .is-hov row look on touch', () => {
  expect(mapCss).toContain('\n.twmap .row.is-hov{background:var(--raised)}');
});
