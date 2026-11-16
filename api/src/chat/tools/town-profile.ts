// get_town_profile: the public profile of the location's town, or null when Townwise has not researched it.
import { z } from 'zod';

import { townProfileOf } from '../../handlers/towns.ts';
import type { ChatTool } from './registry.ts';
import { INVALID_INPUT, NO_INPUT, parseNoInput, viewOf } from './shared.ts';

/** At most this many source links on the card. */
const MAX_SOURCES = 5;

const cited = z.object({ sourceUrls: z.array(z.string()) });
const profileResult = z.object({
  profile: z.object({ name: z.string(), state: z.string(), drivers: z.array(cited), dates: z.array(cited) }).nullable(),
});

/** The distinct https links the profile's drivers and key dates cite, in order, each with its host for display. */
function sourcesOf(profile: { drivers: { sourceUrls: string[] }[]; dates: { sourceUrls: string[] }[] }): { host: string; url: string }[] {
  const urls = [...new Set([...profile.drivers, ...profile.dates].flatMap((item) => item.sourceUrls))];
  return urls.flatMap((url) => {
    const parsed = URL.parse(url);
    return parsed?.protocol === 'https:' ? [{ host: parsed.hostname.replace(/^www\./, ''), url }] : [];
  }).slice(0, MAX_SOURCES);
}

export const townProfileTool: ChatTool<Record<string, never>> = {
  definition: {
    name: 'get_town_profile',
    description: 'The public profile of the location\'s town, when Townwise has researched it: the county\'s food-service employment pattern by month against the Northeast (series is null, with seriesUnavailable saying why, when BLS did not publish the county for the whole year), demand drivers and key dates with sources, and caveats. Null for a town without a profile.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: parseNoInput,
  inputView: () => null,
  resultView: (content) => viewOf(content, profileResult, ({ profile }) => ({
    available: profile !== null,
    town: profile === null ? null : { name: profile.name, state: profile.state },
    sources: profile === null ? [] : sourcesOf(profile),
  })),
  run(tc) {
    const { townId } = tc.location.town;
    const profile = townId === null ? undefined : townProfileOf(townId);
    return Promise.resolve({ content: JSON.stringify({ profile: profile ?? null }) });
  },
};
