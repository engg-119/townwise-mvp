// The model behind the tuning chat, as a port (docs/portal/tuning-chat.md section 6). main.ts builds the real one when
// ANTHROPIC_API_KEY is set and passes it to createTownwiseApi; tests pass a scripted fake. The only other file that
// constructs a client is files/extract/model.ts (the file reader's AI column step), which sends a redacted profile only.
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage, BetaMessageStreamParams, BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** One model call: its events as they stream, then the complete message. The SDK's BetaMessageStream is one. */
export interface ModelStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  /** Rejects with the same error as the iteration when the call fails or is aborted. */
  finalMessage(): Promise<BetaMessage>;
}

export interface ChatModel {
  /** `signal` aborts the provider call (the client closed the connection). */
  stream(params: BetaMessageStreamParams, options: { signal: AbortSignal }): ModelStream;
}

/**
 * The Anthropic API. The SDK's own logger is off: on a malformed stream it would print the raw event data, which
 * holds message text. Retries (2, on connection errors, 429 and 5xx) and timeouts are the SDK's defaults.
 */
export function createAnthropicChatModel(apiKey: string): ChatModel {
  const client = new Anthropic({ apiKey, logLevel: 'off' });
  return {
    stream: (params, options) => client.beta.messages.stream(params, { signal: options.signal }),
  };
}
