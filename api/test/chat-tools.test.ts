// The TownwiseAI tool registry (docs/portal/tuning-chat.md section 4), without Docker: the frozen, append-only order
// of the tools and what the model is sent.
import { describe, expect, it } from 'vitest';

import { TOOL_REGISTRY, TOOLS, toolNamed } from '../src/chat/tools/registry.ts';

/**
 * The contract. Append a new tool's name at the end in the PR that registers it; never rename, remove or move one,
 * because stored conversations name their tool calls and the prompt cache keys on this list. The client's tool table
 * (client/src/chat/tools.ts), once it exists, lists the same names.
 */
const FROZEN_NAMES = ['get_location_overview', 'get_sales_days', 'list_notes', 'get_town_profile', 'propose_note'];

describe('the tool registry', () => {
  it('holds the tools in their frozen order, each name once', () => {
    const names = TOOL_REGISTRY.map((tool) => tool.definition.name);
    expect(names).toEqual(FROZEN_NAMES);
    expect(new Set(names).size).toBe(names.length);
  });

  it('sends the model exactly the registry’s definitions, in order, each streaming its input unbuffered', () => {
    expect(TOOLS).toEqual(TOOL_REGISTRY.map((tool) => tool.definition));
    expect(TOOLS.every((tool) => tool.eager_input_streaming === true)).toBe(true);
  });

  it('finds a tool by name and nothing for an unknown one', () => {
    expect(toolNamed('list_notes')?.definition.name).toBe('list_notes');
    expect(toolNamed('get_forecast')).toBeUndefined();
  });
});
