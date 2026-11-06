// The AI column step's model, as a port (spec 11A). main.ts builds the real one when ANTHROPIC_API_KEY is set and
// passes it to the file reader; tests pass a scripted fake. The request holds only the redacted profile. Nothing here
// logs: a failure leaves as `failed` with the error's class and HTTP status, never its message or the request.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';

import { messageCostMicroUsd } from '../../chat/pricing.ts';
import type { RedactedProfile } from './profile.ts';
import { columnsAnswer, EXTRACT_MAX_TOKENS, EXTRACT_MODEL, EXTRACT_TIMEOUT_MS, SYSTEM_PROMPT, type ColumnChoice } from './prompt.ts';

export type ExtractResult =
  /** `choice` is null when the model declined or its answer did not parse; the call still cost what it cost. */
  | { readonly kind: 'answered'; readonly choice: ColumnChoice | null; readonly costMicroUsd: number }
  | { readonly kind: 'failed'; readonly errType: string; readonly status: number | null };

export interface ExtractModel {
  chooseColumns(profile: RedactedProfile, signal: AbortSignal): Promise<ExtractResult>;
}

/** The request the step sends, exactly: the frozen prompt and the profile as JSON. */
export function extractRequest(profile: RedactedProfile): {
  model: string; max_tokens: number; system: string; messages: { role: 'user'; content: string }[];
} {
  return {
    model: EXTRACT_MODEL,
    max_tokens: EXTRACT_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(profile) }],
  };
}

/**
 * The Anthropic API at low effort, non-streaming, with the server-side refusal fallback the chat uses. The SDK's own
 * logger is off; retries are the SDK's defaults and the timeout is 60 seconds.
 */
export function createAnthropicExtractModel(apiKey: string): ExtractModel {
  const client = new Anthropic({ apiKey, logLevel: 'off' });
  return {
    async chooseColumns(profile, signal) {
      try {
        const message = await client.beta.messages.parse({
          ...extractRequest(profile),
          // Adaptive thinking is Opus 5.5's only mode, so `thinking` is omitted.
          output_config: { effort: 'low', format: betaZodOutputFormat(columnsAnswer) },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        }, { signal, timeout: EXTRACT_TIMEOUT_MS });
        const choice = message.stop_reason === 'refusal' ? null : message.parsed_output;
        return { kind: 'answered', choice, costMicroUsd: messageCostMicroUsd(message) };
      } catch (err) {
        const status: unknown = err instanceof Anthropic.APIError ? err.status : null;
        return { kind: 'failed', errType: err instanceof Error ? err.constructor.name : 'unknown', status: typeof status === 'number' ? status : null };
      }
    },
  };
}
