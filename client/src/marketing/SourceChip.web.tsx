import type { ImageSourcePropType } from 'react-native';

import { sourceChips, type Chip, type ChipSource } from '../portal/sources/site';
import { theme } from '../theme';

// The source chip on the public pages (refine-calendar-and-home design decision 6, spec D40): the portal's chip
// (src/portal/ui/SourceChip.tsx) drawn in DOM, since these pages render DOM, to the same measurements and tokens (the
// --tw- custom properties theme.color names on web), with the same site lookup and committed logos (portal/sources).
// A pill at least 24px tall, round at that height, a `raised` fill with a 1px `border` outline and 8px side padding;
// the logo in a 16px circle on `logoGround`, or the globe in `text3`; 6px; the site's name in 12px sans `text2`, never
// cut. The link around it is 44px tall with the pill centered; in a row the pills sit 8px apart and a wrapped row's
// 20px below. The logo is decoration; the link's name starts with what it shows, and its title is the source's label.
// A logo is the bundle's own same-origin file, so no image loads from another site. Only .web files import this.

const c = theme.color;

export const sourceChipCss = `
.src-chips{display:flex;flex-wrap:wrap;align-items:center;column-gap:8px;row-gap:0;min-width:0}
.src-chip{display:inline-flex;align-items:center;min-height:44px;max-width:100%;text-decoration:none}
.src-pill{display:inline-flex;align-items:center;column-gap:6px;box-sizing:border-box;min-height:24px;max-width:100%;padding:3px 8px;border:1px solid ${c.border};border-radius:12px;background:${c.raised}}
.src-logo{flex:none;display:block;width:16px;height:16px;border-radius:50%;overflow:hidden;background:${c.logoGround}}
.src-logo img{display:block;width:16px;height:16px;object-fit:cover}
.src-glb{flex:none;display:block;width:16px;height:16px;color:${c.text3}}
.src-name{min-width:0;font-family:${theme.font.sans};font-size:12px;line-height:16px;font-weight:400;color:${c.text2};overflow-wrap:anywhere}
`;

/** A committed logo's URL on web: the bundler gives `{ uri }` (or the path itself); anything else draws the globe. */
function logoUrl(logo: ImageSourcePropType | null): string | null {
  const source = logo as unknown;
  if (typeof source === 'string') return source;
  if (typeof source === 'object' && source !== null && 'uri' in source && typeof source.uri === 'string') return source.uri;
  return null;
}

/** The plain globe for a site with no committed logo: Lucide's globe (ISC license, lucide.dev). */
function Globe(): React.JSX.Element {
  return (
    <svg className="src-glb" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

/** One source chip, a link with rel="noopener" as the public pages' source links have. */
export function SourceChip(props: { chip: Chip }): React.JSX.Element {
  const { chip } = props;
  const url = logoUrl(chip.logo);
  return (
    <a className="src-chip" href={chip.url} rel="noopener" title={chip.title} aria-label={chip.name}>
      <span className="src-pill">
        {url === null ? <Globe /> : <span className="src-logo" aria-hidden="true"><img src={url} alt="" width={16} height={16} /></span>}
        <span className="src-name">{chip.shown}</span>
      </span>
    </a>
  );
}

/** A row of source chips, numbering repeats of one site; nothing for no sources. Its style sheet comes with it. */
export function SourceChips(props: { sources: readonly ChipSource[] }): React.JSX.Element | null {
  if (props.sources.length === 0) return null;
  return (
    <span className="src-chips">
      <style href="townwise-source-chip" precedence="default">{sourceChipCss}</style>
      {sourceChips(props.sources).map((chip, index) => <SourceChip key={`${String(index)} ${chip.url}`} chip={chip} />)}
    </span>
  );
}
