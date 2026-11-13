// The person's message as TownwiseAI reads it (docs/portal/tuning-chat.md section 3). Townwise may put context blocks
// before what the person typed: today the location's business rules (spec 10.16), added only when they differ from the
// last rules block on the turn's path, so unchanged rules add nothing and a location with no rules sends the plain
// string it always did. The block is stored with the message, so later requests keep the same prefix. The person's own
// text is always the message's last block; a context block is never it, so typing the tag never makes one.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export const RULES_BLOCK_OPEN = '<business_rules>';
const RULES_BLOCK_CLOSE = '</business_rules>';
const RULES_LEAD = 'Townwise added this before the person\'s message; they didn\'t type it. The business rules the team saved for this location, as of this message, replacing any earlier list in this conversation:';
const NO_RULES = 'There are no business rules for this location now.';

/** What Townwise adds before the person's text. */
export interface MessageContext {
  /** The location's rule texts, oldest first. */
  readonly rules: readonly string[];
}

/**
 * A rule's text as the block carries it: `<` and `>` become their full-width look-alikes, so no rule can close the
 * block early. Any member writes rules and every member's chat at the location reads them, an org admin's included.
 */
function blockLine(rule: string): string {
  return `- ${rule.replaceAll('<', '＜').replaceAll('>', '＞')}`;
}

/** The block for these rules: one line each, or the line saying there are none now. */
export function rulesBlock(texts: readonly string[]): string {
  const body = texts.length === 0 ? [NO_RULES] : texts.map(blockLine);
  return [RULES_BLOCK_OPEN, RULES_LEAD, ...body, RULES_BLOCK_CLOSE].join('\n');
}

/** The context blocks of a person's message: text blocks before its last block. A plain string has none. */
function contextBlocksOf(param: BetaMessageParam): Extract<BetaContentBlockParam, { type: 'text' }>[] {
  if (param.role !== 'user' || typeof param.content === 'string') return [];
  return param.content.slice(0, -1).flatMap((block) => (block.type === 'text' ? [block] : []));
}

/** True for a block Townwise added before the person's text in `content`, never the person's own text. */
export function isContextBlock(content: readonly BetaContentBlockParam[], index: number): boolean {
  const block = content[index];
  return index < content.length - 1 && block?.type === 'text' && block.text.startsWith(RULES_BLOCK_OPEN);
}

/** The text of the last rules block on this path, else null. */
export function lastRulesBlock(history: readonly BetaMessageParam[]): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const param = history[i];
    if (param === undefined) continue;
    const block = contextBlocksOf(param).findLast((candidate) => candidate.text.startsWith(RULES_BLOCK_OPEN));
    if (block !== undefined) return block.text;
  }
  return null;
}

/**
 * The person's message continuing `history` (the turn's path): a plain string, or [rules block, text] when the rules
 * differ from the path's last block. No rules and no earlier block on the path add nothing.
 */
export function userMessageOf(history: readonly BetaMessageParam[], context: MessageContext, content: string): BetaMessageParam {
  const last = lastRulesBlock(history);
  const block = context.rules.length === 0 && last === null ? null : rulesBlock(context.rules);
  if (block === null || block === last) return { role: 'user', content };
  return { role: 'user', content: [{ type: 'text', text: block }, { type: 'text', text: content }] };
}
