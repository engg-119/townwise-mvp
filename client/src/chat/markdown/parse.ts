import MarkdownIt from 'markdown-it';

// TownwiseAI's replies are Markdown (spec P25). markdown-it parses them into a small typed tree that both platforms
// draw with React Native primitives. Raw HTML is never rendered (html: false turns it into text), a link is a link
// only for an absolute http(s) URL, with the host it leads to written after it as text, "words (example.com)", so its
// words can never hide where it goes (D36: a reply may draw on a file), and an image is its alt text (it is never
// fetched).

export type MdInline =
  | { t: 'text'; text: string } | { t: 'code'; text: string } | { t: 'break' }
  | { t: 'strong' | 'em' | 'del'; children: MdInline[] }
  | { t: 'link'; href: string | null; children: MdInline[] };
export type MdBlock =
  | { t: 'paragraph'; children: MdInline[] } | { t: 'heading'; level: number; children: MdInline[] }
  | { t: 'list'; ordered: boolean; start: number; items: MdBlock[][] } | { t: 'code'; text: string }
  | { t: 'quote'; children: MdBlock[] } | { t: 'rule' }
  | { t: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: MdInline[][]; rows: MdInline[][][] };

type Token = ReturnType<MarkdownIt['parse']>[number];
type Align = 'left' | 'center' | 'right' | null;

const md = new MarkdownIt('commonmark', { html: false, linkify: false }).enable(['table', 'strikethrough']);

/** An absolute http: or https: URL, as the URL parser reads it; anything else (javascript:, data:, mailto:, relative) is null. */
export function safeHref(raw: string): string | null {
  return hostOf(raw) === null ? null : raw;
}

/** The host an absolute http(s) URL leads to, as the URL parser reads it (an international name in its xn-- form), else null. */
export function hostOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : null;
  } catch {
    return null;
  }
}

function pushText(out: MdInline[], text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last?.t === 'text') last.text += text;
  else out.push({ t: 'text', text });
}

/** Inline tokens from `start` until the close token that matches `closeType` (or the end). Returns the next index. */
function inlineRun(tokens: readonly Token[], start: number, closeType: string | null): [MdInline[], number] {
  const out: MdInline[] = [];
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.type === closeType) return [out, i + 1];
    switch (token.type) {
      case 'text':
      case 'text_special':
        pushText(out, token.content);
        i += 1;
        break;
      case 'code_inline':
        out.push({ t: 'code', text: token.content });
        i += 1;
        break;
      case 'softbreak':
      case 'hardbreak':
        out.push({ t: 'break' });
        i += 1;
        break;
      case 'image':
        // An image is its alt text, never fetched.
        pushText(out, token.content);
        i += 1;
        break;
      case 'strong_open':
      case 'em_open':
      case 's_open': {
        const [children, next] = inlineRun(tokens, i + 1, token.type.replace('_open', '_close'));
        out.push({ t: token.type === 'strong_open' ? 'strong' : token.type === 'em_open' ? 'em' : 'del', children });
        i = next;
        break;
      }
      case 'link_open': {
        const [children, next] = inlineRun(tokens, i + 1, 'link_close');
        const raw = token.attrGet('href') ?? '';
        const host = hostOf(raw);
        out.push({ t: 'link', href: host === null ? null : raw, children });
        // Outside the link, so it reads as where the link goes.
        if (host !== null) pushText(out, ` (${host})`);
        i = next;
        break;
      }
      default:
        // Anything else (html_inline can't occur with html: false) is dropped, keeping its text if it has any.
        pushText(out, token.content);
        i += 1;
    }
  }
  return [out, i];
}

function inlineOf(token: Token | undefined): MdInline[] {
  return inlineRun(token?.children ?? [], 0, null)[0];
}

function alignOf(token: Token): Align {
  const style = token.attrGet('style') ?? '';
  const match = /text-align:\s*(left|center|right)/.exec(style);
  return match === null ? null : (match[1] as Align);
}

function parseTable(tokens: readonly Token[], start: number): [MdBlock, number] {
  const align: Align[] = [];
  const head: MdInline[][] = [];
  const rows: MdInline[][][] = [];
  let row: MdInline[][] | null = null;
  let inHead = false;
  let i = start + 1;
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token.type === 'table_close') break;
    if (token.type === 'thead_open') inHead = true;
    else if (token.type === 'thead_close') inHead = false;
    else if (token.type === 'tr_open') row = [];
    else if (token.type === 'tr_close') {
      if (row !== null && !inHead) rows.push(row);
      row = null;
    } else if (token.type === 'th_open' || token.type === 'td_open') {
      const cell = inlineOf(tokens[i + 1]);
      if (inHead) {
        head.push(cell);
        align.push(alignOf(token));
      } else row?.push(cell);
    }
  }
  return [{ t: 'table', align, head, rows }, i + 1];
}

/** Block tokens from `start` until the close token that matches `closeType` (or the end). Returns the next index. */
function blockRun(tokens: readonly Token[], start: number, closeType: string | null): [MdBlock[], number] {
  const out: MdBlock[] = [];
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.type === closeType) return [out, i + 1];
    switch (token.type) {
      case 'paragraph_open':
        out.push({ t: 'paragraph', children: inlineOf(tokens[i + 1]) });
        i += 3;
        break;
      case 'heading_open':
        out.push({ t: 'heading', level: Number(token.tag.slice(1)), children: inlineOf(tokens[i + 1]) });
        i += 3;
        break;
      case 'fence':
      case 'code_block':
        out.push({ t: 'code', text: token.content.replace(/\n$/, '') });
        i += 1;
        break;
      case 'hr':
        out.push({ t: 'rule' });
        i += 1;
        break;
      case 'blockquote_open': {
        const [children, next] = blockRun(tokens, i + 1, 'blockquote_close');
        out.push({ t: 'quote', children });
        i = next;
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        const closeList = ordered ? 'ordered_list_close' : 'bullet_list_close';
        const items: MdBlock[][] = [];
        let j = i + 1;
        while (j < tokens.length && tokens[j]?.type !== closeList) {
          const [item, next] = blockRun(tokens, j + 1, 'list_item_close');
          items.push(item);
          j = next;
        }
        const start = Number(token.attrGet('start') ?? 1);
        out.push({ t: 'list', ordered, start: Number.isFinite(start) ? start : 1, items });
        i = j + 1;
        break;
      }
      case 'table_open': {
        const [table, next] = parseTable(tokens, i);
        out.push(table);
        i = next;
        break;
      }
      default:
        i += 1;
    }
  }
  return [out, i];
}

export function parseMarkdown(source: string): MdBlock[] {
  return blockRun(md.parse(source, {}), 0, null)[0];
}
