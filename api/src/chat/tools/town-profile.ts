// get_town_profile: the public profile of the location's town, or null when Townwise has not researched it.
import { townProfileOf } from '../../handlers/towns.ts';
import type { ChatTool } from './registry.ts';
import { INVALID_INPUT, NO_INPUT, parseNoInput } from './shared.ts';

export const townProfileTool: ChatTool<Record<string, never>> = {
  definition: {
    name: 'get_town_profile',
    description: 'The public profile of the location\'s town, when Townwise has researched it: the county\'s food-service employment pattern by month against the Northeast, demand drivers and key dates with sources, and caveats. Null for a town without a profile.',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: parseNoInput,
  run(tc) {
    const { townId } = tc.location.town;
    const profile = townId === null ? undefined : townProfileOf(townId);
    return Promise.resolve({ content: JSON.stringify({ profile: profile ?? null }) });
  },
};
