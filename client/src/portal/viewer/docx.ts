import { ViewerError } from './errors';
import { VIEW_LIMITS } from './limits';
import {
  attributeOf, childElement, childElements, openPackage, readingPackage, readXml, relationshipOf, relationships,
} from './ooxml';

// A Word document (.docx) as plain blocks, in body order: paragraphs (run text, a tab as a tab, a line break as a
// line break, the heading level of a Title or Heading style) and tables (each cell's paragraphs joined by line
// breaks; a table inside a cell flattened into its text). Content controls and custom XML are descended into;
// deleted text, field codes, drawings and text boxes are not read. More than two blank paragraphs in a row show as
// two. Reading stops at VIEW_LIMITS.documentBlocks paragraphs plus table rows, and `truncated` says so.

export type DocBlock =
  | { kind: 'paragraph'; text: string; heading: 0 | 1 | 2 | 3 }
  | { kind: 'table'; rows: string[][] };

/** Paragraph content that is not shown: properties, deletions, and the source side of a move. */
const SKIPPED_IN_PARAGRAPH = new Set(['pPr', 'rPr', 'del', 'moveFrom', 'sdtPr', 'sdtEndPr']);
/** Wrappers whose children are the blocks (or rows, or cells) they wrap. */
const WRAPPERS = new Set(['sdt', 'customXml']);

type Heading = 0 | 1 | 2 | 3;

function headingOfName(name: string): Heading | null {
  const lower = name.toLowerCase();
  if (lower === 'title') return 1;
  const match = /^heading ?([1-9])$/.exec(lower);
  if (match === null) return null;
  return Math.min(3, Number(match[1])) as Heading;
}

/** The children of `parent` with the content of any content control (w:sdt) or custom XML put in its place. */
function unwrapped(parent: Element): Element[] {
  const found: Element[] = [];
  for (const child of childElements(parent)) {
    if (!WRAPPERS.has(child.localName)) found.push(child);
    else if (child.localName === 'sdt') {
      const content = childElement(child, 'sdtContent');
      if (content !== undefined) found.push(...unwrapped(content));
    } else found.push(...unwrapped(child));
  }
  return found;
}

function runText(run: Element): string {
  let text = '';
  for (const part of childElements(run)) {
    switch (part.localName) {
      case 't':
        text += part.textContent;
        break;
      case 'tab':
      case 'ptab':
        text += '\t';
        break;
      case 'br':
      case 'cr':
        text += '\n';
        break;
      case 'noBreakHyphen':
        text += '-';
        break;
      default:
        break;
    }
  }
  return text;
}

/** A paragraph's text: its runs, inside hyperlinks, insertions, fields, smart tags and inline content controls. */
function paragraphText(element: Element): string {
  let text = '';
  for (const child of childElements(element)) {
    if (SKIPPED_IN_PARAGRAPH.has(child.localName)) continue;
    if (child.localName === 'r') text += runText(child);
    else if (child.localName === 'AlternateContent') {
      // Markup compatibility: read the first choice only, so its fallback is not read twice.
      const choice = childElements(child)[0];
      if (choice !== undefined) text += paragraphText(choice);
    } else text += paragraphText(child);
  }
  return text;
}

function cellText(cell: Element): string {
  const parts: string[] = [];
  for (const child of unwrapped(cell)) {
    if (child.localName === 'p') parts.push(paragraphText(child));
    else if (child.localName === 'tbl') {
      parts.push(tableRows(child, Number.MAX_SAFE_INTEGER).rows.map((row) => row.join('\t')).join('\n'));
    }
  }
  return parts.join('\n');
}

/** A table's rows of cell text, at most `maxRows` rows and VIEW_LIMITS.sheetColumns cells a row. */
function tableRows(table: Element, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  for (const row of unwrapped(table)) {
    if (row.localName !== 'tr') continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const cells = unwrapped(row).filter((cell) => cell.localName === 'tc');
    if (cells.length > VIEW_LIMITS.sheetColumns) truncated = true;
    rows.push(cells.slice(0, VIEW_LIMITS.sheetColumns).map(cellText));
  }
  return { rows, truncated };
}

/**
 * A Word document's blocks, in order. Throws ViewerError: `encrypted` for a password-protected document,
 * `unsupported` for an old binary .doc or a ZIP feature the reader refuses, `too_big` past the ZIP guards or a
 * document part over VIEW_LIMITS.xmlBytes, `damaged` for a broken package.
 */
export async function readDocument(bytes: Uint8Array): Promise<{ blocks: DocBlock[]; truncated: boolean }> {
  return readingPackage(async () => {
    const pkg = openPackage(bytes);
    const main = relationshipOf(await relationships(pkg, ''), 'officeDocument')?.target ?? 'word/document.xml';
    const doc = await readXml(pkg, main);
    const body = childElement(doc?.documentElement, 'body');
    if (doc?.documentElement.localName !== 'document' || body === undefined) throw new ViewerError('damaged', 'no document body');

    const styleNames = new Map<string, string>();
    const stylesPart = relationshipOf(await relationships(pkg, main), 'styles')?.target;
    const styles = stylesPart === undefined ? null : await readXml(pkg, stylesPart);
    for (const style of childElements(styles?.documentElement, 'style')) {
      const id = attributeOf(style, 'styleId', true);
      const name = childElement(style, 'name');
      const value = name === undefined ? null : attributeOf(name, 'val', true);
      if (id !== null && value !== null) styleNames.set(id, value);
    }
    const headingOf = (paragraph: Element): Heading => {
      const style = childElement(childElement(paragraph, 'pPr'), 'pStyle');
      const id = style === undefined ? null : attributeOf(style, 'val', true);
      if (id === null) return 0;
      return headingOfName(styleNames.get(id) ?? '') ?? headingOfName(id) ?? 0;
    };

    const blocks: DocBlock[] = [];
    let budget: number = VIEW_LIMITS.documentBlocks;
    let truncated = false;
    let blankRun = 0;
    for (const child of unwrapped(body)) {
      if (child.localName !== 'p' && child.localName !== 'tbl') continue;
      if (budget <= 0) {
        truncated = true;
        break;
      }
      if (child.localName === 'p') {
        const text = paragraphText(child);
        if (text.trim() === '') {
          blankRun += 1;
          if (blankRun > 2) continue;
          blocks.push({ kind: 'paragraph', text: '', heading: 0 });
        } else {
          blankRun = 0;
          blocks.push({ kind: 'paragraph', text, heading: headingOf(child) });
        }
        budget -= 1;
      } else {
        blankRun = 0;
        const table = tableRows(child, budget);
        truncated ||= table.truncated;
        if (table.rows.length === 0) continue;
        budget -= table.rows.length;
        blocks.push({ kind: 'table', rows: table.rows });
      }
    }
    return { blocks, truncated };
  });
}
