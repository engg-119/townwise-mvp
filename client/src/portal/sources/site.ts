import type { ImageSourcePropType } from 'react-native';

import { SITES } from './logos';

// A source's site, for the source chips (refine-calendar-and-home design decision 6; ui/SourceChip.tsx and
// src/marketing/SourceChip.web.tsx): its name and committed logo from logos.ts, which scripts/source-logos/fetch.mts
// generates from its hand-written sites.json. Pure: nothing here reads anything from another site.

export interface SourceSite { name: string; logo: ImageSourcePropType | null }

/** A source to show as a chip: its link, and its own label when it has one. */
export interface ChipSource { url: string; label?: string }

/** One chip: what it shows, its accessible name, its title (web), and its logo, or null for the globe. */
export interface Chip { url: string; shown: string; name: string; title: string; logo: ImageSourcePropType | null }

/** The host of an http(s) URL, in lower case and without www.; '' for anything else. */
function hostOf(url: string): string {
  const match = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url);
  return (match?.[1] ?? '').toLowerCase().replace(/^www\./, '');
}

/**
 * A source's site: the URL's host without www., then its parent domains down to two labels (home.dartmouth.edu finds
 * dartmouth.edu), else the host itself as the name with no logo, so its chip shows the globe.
 */
export function sourceSite(url: string): SourceSite {
  const host = hostOf(url);
  const labels = host.split('.');
  for (let at = 0; at <= labels.length - 2; at += 1) {
    const site = SITES[labels.slice(at).join('.')];
    if (site !== undefined) return site;
  }
  return { name: host === '' ? url : host, logo: null };
}

/**
 * The chips of one row, in order. Each shows its site's name, numbered from the second on when two show the same
 * ("Dartmouth Registrar 2"). Its accessible name starts with what it shows (WCAG 2.5.3): "{shown}. Source: {label}" when
 * its own label differs from the site's name, else "{shown}. Source". Its title is its label, or its link without one.
 */
export function sourceChips(sources: readonly ChipSource[]): Chip[] {
  const seen = new Map<string, number>();
  return sources.map((source) => {
    const site = sourceSite(source.url);
    const count = (seen.get(site.name) ?? 0) + 1;
    seen.set(site.name, count);
    const shown = count === 1 ? site.name : `${site.name} ${String(count)}`;
    const label = source.label === undefined || source.label === '' ? null : source.label;
    const name = label === null || label === site.name ? `${shown}. Source` : `${shown}. Source: ${label}`;
    return { url: source.url, shown, name, title: label ?? source.url, logo: site.logo };
  });
}
