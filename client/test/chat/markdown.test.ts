import { hostOf, parseMarkdown, safeHref } from '../../src/chat/markdown/parse';

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
it('writes the host an http(s) link leads to after it, outside the link, so its words never hide where it goes (D36)', () => {
  expect(parseMarkdown('See [the town page](https://www.example.com/events) today.')).toEqual([{ t: 'paragraph', children: [
    { t: 'text', text: 'See ' },
    { t: 'link', href: 'https://www.example.com/events', children: [{ t: 'text', text: 'the town page' }] },
    { t: 'text', text: ' (www.example.com) today.' },
  ] }]);
  // Words that look like another site, a user part before the host, a port, and an international name in its xn-- form.
  expect(JSON.stringify(parseMarkdown('[bank.com](https://evil.example/login)'))).toContain('"text":" (evil.example)"');
  expect(hostOf('https://bank.com@evil.example/')).toBe('evil.example');
  expect(hostOf('http://example.com:8080/x')).toBe('example.com:8080');
  expect(hostOf('https://exämple.com/')).toBe('xn--exmple-cua.com');
  // An unsafe link has no host after it.
  expect(parseMarkdown('[a](mailto:a@example.com)')).toEqual([{ t: 'paragraph', children: [{ t: 'link', href: null, children: [{ t: 'text', text: 'a' }] }] }]);
});
it('keeps half-written syntax literal while it streams', () => {
  expect(parseMarkdown('Sales were **up')).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: 'Sales were **up' }] }]);
});
