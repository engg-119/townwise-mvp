import { appPath, hostOf, parseMarkdown, safeHref } from '../../src/chat/markdown/parse';

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
it('links only a Your data item\'s exact path in the app, with "(Your data)" after it (D63)', () => {
  const loc = 'a'.repeat(24);
  const cal = `c_${'b'.repeat(24)}`;
  expect(parseMarkdown(`Added [Bookings](/locations/${loc}/data/${cal}).`)).toEqual([{ t: 'paragraph', children: [
    { t: 'text', text: 'Added ' },
    { t: 'link', href: `/locations/${loc}/data/${cal}`, children: [{ t: 'text', text: 'Bookings' }] },
    { t: 'text', text: ' (Your data).' },
  ] }]);
  expect(appPath(`/locations/${loc}/data/f_${'c'.repeat(24)}`)).toBe(`/locations/${loc}/data/f_${'c'.repeat(24)}`);
  // Any other path, a query, a sales upload's ref, another section or a protocol-relative URL stays text.
  for (const raw of [
    `/locations/${loc}/data/${cal}?x=1`, `/locations/${loc}/data/u_${'b'.repeat(24)}`, `/locations/${loc}/settings`, `//evil.example/locations/${loc}/data/${cal}`,
    `/locations/${loc}/data/${cal}/../../settings`, '/admin',
  ]) expect(JSON.stringify(parseMarkdown(`[x](${raw})`))).not.toContain('"href":"');
});
it('keeps half-written syntax literal while it streams', () => {
  expect(parseMarkdown('Sales were **up')).toEqual([{ t: 'paragraph', children: [{ t: 'text', text: 'Sales were **up' }] }]);
});
