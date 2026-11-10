// A tool call a stored conversation made, read back for a handler that acts on its card (handlers/chat-item-proposals.ts),
// so what is kept is exactly the call's input as the conversation stored it, never anything from the request.
import type { BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { StoredMessage } from '../stores/chat-conversations.ts';

export interface ShownToolCall {
  readonly input: unknown;
  /** The result the model read for the call. */
  readonly content: BetaToolResultBlockParam['content'];
}

/**
 * The `tool_use` block with this name and id in a stored assistant message whose `tool_result` is not an error; null
 * for an unknown id, another tool's call, or a call that failed, never ran or has no result.
 */
export function shownToolCall(messages: readonly StoredMessage[], name: string, id: string): ShownToolCall | null {
  let call: { input: unknown } | null = null;
  let result: BetaToolResultBlockParam | null = null;
  for (const message of messages) {
    const param = JSON.parse(message.param) as BetaMessageParam;
    if (typeof param.content === 'string') continue;
    for (const block of param.content ?? []) {
      if (param.role === 'assistant' && block.type === 'tool_use' && block.id === id && block.name === name) call = { input: block.input };
      if (param.role === 'user' && block.type === 'tool_result' && block.tool_use_id === id) result = block;
    }
  }
  if (call === null || result === null || result.is_error === true) return null;
  return { input: call.input, content: result.content };
}
