// The person's message as TownwiseAI reads it (docs/portal/tuning-chat.md section 3). Townwise may put context blocks
// before what the person typed: today the location's business rules (spec 10.16), added only when they differ from the
// last rules block on the turn's path, so unchanged rules add nothing and a location with no rules sends the plain
// string it always did. The block is stored with the message, so later requests keep the same prefix until a newer
// block replaces it; requests then send the older one as a stub (historyForModel). A rule with a schedule (D31) has a
// second, indented line with the schedule in code-made words, which a rule's one-line text can never forge: it can't
// start a line, and "Forecast schedule" followed by a colon in it loses the colon, so it can't read as that line inline
// either. With no schedule anywhere the block is what it was before schedules existed. After it comes an attachments
// block when the person attached files from Your data (D36, chat/attachments.ts): refs and kind words only, never a file
// name, and never replaced by a stub, since it holds no content. The person's own text is always the message's last
// block; a context block is never it, so typing either tag never makes one.
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';

export const RULES_BLOCK_OPEN = '<business_rules>';
const RULES_BLOCK_CLOSE = '</business_rules>';
export const ATTACHMENTS_BLOCK_OPEN = '<attachments>';
const RULES_LEAD = 'Townwise added this before the person\'s message; they didn\'t type it. The business rules the team saved for this location, as of this message, replacing any earlier list in this conversation:';
const NO_RULES = 'There are no business rules for this location now.';

/** A rule as the block lists it: its text, and its schedule's summary (scheduleSummary) when it has one. */
export interface BlockRule {
  readonly text: string;
  readonly summary: string | null;
}

/** What Townwise adds before the person's text. */
export interface MessageContext {
  /** The location's rules, oldest first. */
  readonly rules: readonly BlockRule[];
  /** The attachments block (chat/attachments.ts) when the person attached files to this message. */
  readonly attachments?: string | null;
}

/** "Forecast schedule" in any case and spacing, and what follows it up to the next letter or digit. */
const SCHEDULE_LABEL = /(forecast[^\p{L}\p{N}]*schedule)([^\p{L}\p{N}]*)/giu;
/** A colon, or a look-alike of one. */
const COLON = /[:\uFF1A\uFE55\uFE13\uA789\u2236\u02F8]/u;

/**
 * A rule's text as the block carries it: `<` and `>` become their full-width look-alikes, so no rule can close the
 * block early, and "Forecast schedule" followed by a colon becomes "Forecast schedule -", so no rule's words can pass
 * for the schedule line Townwise writes under it. Any member writes rules and every member's chat at the location reads
 * them, an org admin's included.
 */
function blockLines(rule: BlockRule): string[] {
  const text = rule.text.replace(SCHEDULE_LABEL, (all: string, label: string, after: string) => (
    COLON.test(after) ? `${label} -${/\s$/u.test(after) ? ' ' : ''}` : all
  ));
  const line = `- ${text.replaceAll('<', '＜').replaceAll('>', '＞')}`;
  return rule.summary === null ? [line] : [line, `  Forecast schedule: ${rule.summary}`];
}

/** The block for these rules: a line each (two with a schedule), or the line saying there are none now. */
export function rulesBlock(rules: readonly BlockRule[]): string {
  const body = rules.length === 0 ? [NO_RULES] : rules.flatMap(blockLines);
  return [RULES_BLOCK_OPEN, RULES_LEAD, ...body, RULES_BLOCK_CLOSE].join('\n');
}

/** The context blocks of a person's message: text blocks before its last block. A plain string has none. */
function contextBlocksOf(param: BetaMessageParam): Extract<BetaContentBlockParam, { type: 'text' }>[] {
  if (param.role !== 'user' || typeof param.content === 'string') return [];
  return param.content.slice(0, -1).flatMap((block) => (block.type === 'text' ? [block] : []));
}

/**
 * True for a block Townwise added before the person's text in `content` (business rules or attachments), never the
 * person's own text, which is always the last block.
 */
export function isContextBlock(content: readonly BetaContentBlockParam[], index: number): boolean {
  const block = content[index];
  return index < content.length - 1 && block?.type === 'text'
    && (block.text.startsWith(RULES_BLOCK_OPEN) || block.text.startsWith(ATTACHMENTS_BLOCK_OPEN));
}

/** True for a business_rules context block. */
function isRulesBlock(content: readonly BetaContentBlockParam[], index: number): boolean {
  const block = content[index];
  return isContextBlock(content, index) && block?.type === 'text' && block.text.startsWith(RULES_BLOCK_OPEN);
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
 * The person's message continuing `history` (the turn's path): a plain string, or [rules block?, attachments block?,
 * text], with the rules block only when the rules differ from the path's last block. No rules and no earlier block on
 * the path add nothing.
 */
export function userMessageOf(history: readonly BetaMessageParam[], context: MessageContext, content: string): BetaMessageParam {
  const last = lastRulesBlock(history);
  const rules = context.rules.length === 0 && last === null ? null : rulesBlock(context.rules);
  const attachments = context.attachments ?? null;
  const blocks: string[] = [];
  if (rules !== null && rules !== last) blocks.push(rules);
  if (attachments !== null) blocks.push(attachments);
  if (blocks.length === 0) return { role: 'user', content };
  return { role: 'user', content: [...blocks.map((text) => ({ type: 'text' as const, text })), { type: 'text', text: content }] };
}

/** What a request sends in place of a rules block that a newer one on the path replaced. */
export const REPLACED_RULES_BLOCK = '[Earlier business rules, replaced by a later list.]';

/** The positions of the rules blocks in a message. */
function rulesBlockIndexes(param: BetaMessageParam): number[] {
  if (param.role !== 'user' || typeof param.content === 'string') return [];
  const { content } = param;
  return content.flatMap((_block, index) => (isRulesBlock(content, index) ? [index] : []));
}

/**
 * The path as the model reads it (the stored messages never change): every rules block but the newest, counting the
 * turn's new message `next`, becomes REPLACED_RULES_BLOCK, so the model reads only the current list and a deleted or
 * edited rule's text is not sent again (D28's practice). The newest block stays in place until a newer one arrives, so
 * the cached prefix changes only when the rules do.
 */
export function historyForModel(history: readonly BetaMessageParam[], next: BetaMessageParam | null): BetaMessageParam[] {
  const newestAt = next !== null && rulesBlockIndexes(next).length > 0
    ? -1
    : history.findLastIndex((param) => rulesBlockIndexes(param).length > 0);
  return history.map((param, at) => {
    const indexes = rulesBlockIndexes(param);
    const replaced = at === newestAt ? indexes.slice(0, -1) : indexes;
    if (replaced.length === 0 || param.role !== 'user' || typeof param.content === 'string') return param;
    return {
      ...param,
      content: param.content.map((block, index) => (replaced.includes(index) ? { type: 'text' as const, text: REPLACED_RULES_BLOCK } : block)),
    };
  });
}
