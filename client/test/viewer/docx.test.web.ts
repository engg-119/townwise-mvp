import './setup';

import { readDocument, type DocBlock } from '../../src/portal/viewer/docx';
import { ViewerError } from '../../src/portal/viewer/errors';
import { VIEW_LIMITS } from '../../src/portal/viewer/limits';
import { buildPackage, documentBytes, para } from './fixtures';

// Word documents as blocks. Every document here is synthetic.

const p = (text: string, heading: 0 | 1 | 2 | 3 = 0): DocBlock => ({ kind: 'paragraph', text, heading });

async function blocksOf(body: string, styles?: string): Promise<DocBlock[]> {
  return (await readDocument(documentBytes(body, styles))).blocks;
}

test('paragraphs keep run text, tabs and line breaks', async () => {
  const body = '<w:p><w:r><w:t>One</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> two</w:t><w:tab/><w:t>three</w:t></w:r>'
    + '<w:r><w:br/><w:t>four</w:t><w:cr/><w:t>five</w:t><w:noBreakHyphen/><w:t>six</w:t></w:r></w:p>';
  expect(await blocksOf(body)).toEqual([p('One two\tthree\nfour\nfive-six')]);
});

test('hyperlinks, insertions, simple fields and content controls are read; deletions and field codes are not', async () => {
  const body = '<w:p><w:hyperlink><w:r><w:t>link</w:t></w:r></w:hyperlink>'
    + '<w:ins><w:r><w:t xml:space="preserve"> added</w:t></w:r></w:ins>'
    + '<w:del><w:r><w:delText> removed</w:delText></w:r></w:del>'
    + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r><w:t xml:space="preserve"> 7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    + '<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent><w:r><w:t xml:space="preserve"> inline control</w:t></w:r></w:sdtContent></w:sdt>'
    + '<mc:AlternateContent><mc:Choice Requires="w14"><w:r><w:t xml:space="preserve"> choice</w:t></w:r></mc:Choice>'
    + '<mc:Fallback><w:r><w:t xml:space="preserve"> fallback</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>';
  expect(await blocksOf(body)).toEqual([p('link added 7 inline control choice')]);
});

test('headings come from the style’s name, or its id when the styles part has none', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>';
  const body = para('Report', 'Title') + para('Localized', 'berschrift1') + para('Section', 'Heading2') + para('Sub', 'Heading3')
    + para('Deep', 'Heading6') + para('Said', 'Quote') + para('Body');
  expect(await blocksOf(body, styles)).toEqual([
    p('Report', 1), p('Localized', 1), p('Section', 2), p('Sub', 3), p('Deep', 3), p('Said'), p('Body'),
  ]);
});

test('tables are rows of cell text; a cell’s paragraphs join by line breaks and a nested table flattens into it', async () => {
  const cell = (inner: string): string => `<w:tc><w:tcPr/>${inner}</w:tc>`;
  const nested = `<w:tbl><w:tr>${cell(para('n1'))}${cell(para('n2'))}</w:tr><w:tr>${cell(para('n3'))}${cell(para('n4'))}</w:tr></w:tbl>`;
  const body = para('Before')
    + `<w:tbl><w:tblPr/><w:tr>${cell(para('Day'))}${cell(para('Guests'))}</w:tr>`
    + `<w:tr>${cell(para('Mon') + para('late'))}${cell(nested)}</w:tr>`
    + `<w:sdt><w:sdtContent><w:tr><w:sdt><w:sdtContent>${cell(para('in control'))}</w:sdtContent></w:sdt>${cell('<w:p/>')}</w:tr></w:sdtContent></w:sdt></w:tbl>`
    + para('After');
  expect(await blocksOf(body)).toEqual([
    p('Before'),
    { kind: 'table', rows: [['Day', 'Guests'], ['Mon\nlate', 'n1\tn2\nn3\tn4'], ['in control', '']] },
    p('After'),
  ]);
});

test('block-level content controls and custom XML are descended into', async () => {
  const body = `<w:sdt><w:sdtPr/><w:sdtContent>${para('In a control')}</w:sdtContent></w:sdt><w:customXml>${para('In custom XML')}</w:customXml>`;
  expect(await blocksOf(body)).toEqual([p('In a control'), p('In custom XML')]);
});

test('blank paragraphs are kept, but more than two in a row show as two', async () => {
  const blank = '<w:p/>';
  const body = para('A') + blank + para('B') + blank + blank + blank + blank + para('  ', 'Heading1') + para('C');
  expect(await blocksOf(body)).toEqual([p('A'), p(''), p('B'), p(''), p(''), p('C')]);
});

test('reading stops at the block cap and says so', async () => {
  const body = Array.from({ length: VIEW_LIMITS.documentBlocks + 3 }, (_p, i) => para(String(i))).join('');
  const read = await readDocument(documentBytes(body));
  expect(read.blocks).toHaveLength(VIEW_LIMITS.documentBlocks);
  expect(read.truncated).toBe(true);
});

test('a table’s rows count toward the cap', async () => {
  const row = '<w:tr><w:tc><w:p><w:r><w:t>r</w:t></w:r></w:p></w:tc></w:tr>';
  const body = para('first') + `<w:tbl>${row.repeat(VIEW_LIMITS.documentBlocks + 10)}</w:tbl>` + para('never');
  const read = await readDocument(documentBytes(body));
  expect(read.blocks).toHaveLength(2);
  const table = read.blocks[1];
  expect(table?.kind === 'table' ? table.rows.length : 0).toBe(VIEW_LIMITS.documentBlocks - 1);
  expect(read.truncated).toBe(true);
});

test('a package with no document body is damaged; an encrypted document is encrypted', async () => {
  await expect(readDocument(buildPackage({ 'xl/workbook.xml': '<workbook/>' }))).rejects.toEqual(expect.objectContaining({ reason: 'damaged' }));
  const ole = new Uint8Array(2048);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  ole.set(Array.from('EncryptedPackage').flatMap((char) => [char.charCodeAt(0), 0]), 600);
  await expect(readDocument(ole)).rejects.toEqual(expect.objectContaining({ reason: 'encrypted' }));
  await expect(readDocument(ole)).rejects.toBeInstanceOf(ViewerError);
});
