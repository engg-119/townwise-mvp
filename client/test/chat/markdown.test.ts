import { parseMarkdown, safeHref } from '../../src/chat/markdown/parse';

// TownwiseAI's replies are Markdown (spec P25): the tree the renderers draw, never raw HTML or an unsafe link.

it('parses paragraphs, bold, lists, code, quotes and tables into blocks', () => {
  expect(parseMarkdown('**42** guests\n\n- a\n- b').map((b) => b.t)).toEqual(['paragraph', 'list']);
  expect(parseMarkdown('| Day | Note |\n|---|---:|\n| Mon | Closed |')[0]).toMatchObject({ t: 'table', align: [null, 'right'] });
  expect(parseMarkdown('```\nx = 1\n```\n\n> quoted\n\n---').map((b) => b.t)).toEqual(['code', 'quote', 'rule']);
  expect(parseMarkdown('3. one\n4. two')[0]).toMatchObject({ t: 'list', ordered: true, start: 3 });
  expect(parseMarkdown('# Title')[0]).toMatchObject({ t: 'heading', level: 1 });
});
it('never renders raw HTML or an unsafe link', () => {
  expect(parseMarkdown('<script>x</script>')).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: '<script>x</script>' }] }]);
  expect(JSON.stringify(parseMarkdown('[a](javascript:alert(1)) [b](/x) [c](mailto:a@example.com)'))).not.toContain('"href":"');
  expect(safeHref('https://bls.gov/x')).toBe('https://bls.gov/x');
  expect(parseMarkdown('![chart](https://example.com/a.png)')).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: 'chart' }] }]);
});
it('keeps half-written syntax literal while it streams', () => {
  expect(parseMarkdown('Sales were **up')).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: 'Sales were **up' }] }]);
});
