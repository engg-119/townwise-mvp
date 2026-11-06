// The one HTML and plain-text layout every Townwise email uses (spec D14). Pure; the words come from templates.ts.
// Rules a client can't break: inline styles only (no <style>, <link>, <script>, <img> or web fonts), table layout, a
// dark design declared as dark, every text element sets its own color, and every background cell also carries bgcolor
// (Outlook ignores CSS backgrounds on cells). No images at all, so nothing can act as an open pixel. Colors are from
// client/src/theme.ts; mint is the one accent, and the button is white, as on the site.

/** The theme colors the email uses, and only these (mail.test.ts pins it). */
export const MAIL_COLORS = {
  ground: '#080a0d',
  panel: '#101317',
  border: '#34383e',
  white: '#eff2f6',
  text2: '#b5bbc2',
  text3: '#9a9fa6',
  mint: '#7bd2b4',
} as const;

const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = 'ui-monospace,Menlo,Consolas,monospace';
const C = MAIL_COLORS;

/** One item of the footer's link line: plain text, or a link whose plain-text form is `text`. */
export interface FooterItem {
  readonly label: string;
  readonly href?: string;
  readonly text?: string;
}

/** Plain text in every field: the layout escapes it. Every href starts with the web app's origin. */
export interface LayoutParts {
  readonly subject: string;
  readonly preheader: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly button: { readonly label: string; readonly href: string };
  readonly small: string;
  readonly footer: string;
  readonly footerLinks: readonly FooterItem[];
}

const HTML_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function spacer(px: number): string {
  return `<tr><td height="${String(px)}" style="height:${String(px)}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
}

function textRow(style: string, html: string): string {
  return `<tr><td style="${style}">${html}</td></tr>`;
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${C.white};text-decoration:underline">${escapeHtml(label)}</a>`;
}

const TABLE = 'cellpadding="0" cellspacing="0" border="0" role="presentation"';

export function htmlLayout(parts: LayoutParts): string {
  const body = `margin:0;font-family:${SANS};font-size:16px;line-height:24px;color:${C.white}`;
  const footerLinks = parts.footerLinks
    .map((item) => (item.href === undefined ? escapeHtml(item.label) : link(item.href, item.label)))
    .join(' &middot; ');
  const card = [
    textRow(`font-family:${SANS};font-size:18px;line-height:24px;font-weight:600;letter-spacing:-0.18px;color:${C.white}`, 'Townwise'),
    spacer(24),
    `<tr><td><table ${TABLE} width="32"><tr><td width="32" height="2" bgcolor="${C.mint}" style="font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>`,
    spacer(12),
    textRow(`font-family:${MONO};font-size:12px;line-height:16px;letter-spacing:0.48px;text-transform:uppercase;color:${C.text3}`, escapeHtml(parts.eyebrow)),
    spacer(8),
    textRow(`font-family:${SANS};font-size:28px;line-height:32px;font-weight:600;letter-spacing:-0.56px;color:${C.white}`, escapeHtml(parts.heading)),
    ...parts.paragraphs.flatMap((paragraph, i) => [
      spacer(i === 0 ? 16 : 12),
      textRow(body, escapeHtml(paragraph)),
    ]),
    spacer(24),
    `<tr><td><table ${TABLE}><tr><td bgcolor="${C.white}" style="background-color:${C.white};border-radius:0">`
      + `<a href="${escapeHtml(parts.button.href)}" style="display:inline-block;padding:12px 18px;font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;color:${C.ground};text-decoration:none">${escapeHtml(parts.button.label)}</a>`
      + '</td></tr></table></td></tr>',
    spacer(12),
    textRow(`font-family:${SANS};font-size:14px;line-height:20px;color:${C.text3}`, escapeHtml(parts.small)),
  ].join('');
  const small = `font-family:${SANS};font-size:14px;line-height:20px;color:${C.text3}`;
  return [
    '<!doctype html>',
    `<html lang="en" dir="ltr" style="color-scheme:dark"><head>`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="supported-color-schemes" content="dark">',
    `<title>${escapeHtml(parts.subject)}</title>`,
    `</head><body bgcolor="${C.ground}" style="margin:0;padding:0;background-color:${C.ground}">`,
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.ground};opacity:0">${escapeHtml(parts.preheader)}</div>`,
    `<table ${TABLE} width="100%" bgcolor="${C.ground}" style="background-color:${C.ground}"><tr><td align="center" style="padding:32px 16px">`,
    `<table ${TABLE} width="100%" style="max-width:560px">`,
    `<tr><td bgcolor="${C.panel}" style="background-color:${C.panel};border:1px solid ${C.border};padding:28px">`,
    `<table ${TABLE} width="100%">${card}</table>`,
    '</td></tr>',
    spacer(24),
    textRow(small, escapeHtml(parts.footer)),
    spacer(8),
    textRow(small, footerLinks),
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('\n');
}

export function textLayout(parts: LayoutParts): string {
  const footerLinks = parts.footerLinks.map((item) => item.text ?? item.label).join(' · ');
  return [
    parts.heading,
    '',
    ...parts.paragraphs.flatMap((paragraph) => [paragraph, '']),
    `${parts.button.label}: ${parts.button.href}`,
    parts.small,
    '',
    parts.footer,
    footerLinks,
    '',
  ].join('\n');
}
