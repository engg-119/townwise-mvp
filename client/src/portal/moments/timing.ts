import type { Statement } from './moments';

// The statement moments' timeline (spec 15.8). Pure: the overlay reads it, the tests pin it. Every time is in ms
// from the moment the ground is up.

/** The ground is up at 0; the first word starts here. */
export const START_MS = 120;
/** Each word fades from 0 to 1 (theme.motion.easeOut), inside spec 15.6's 150 to 200ms. */
export const FADE_MS = 200;
/** Between word starts in a line, capped so a line's base rhythm never exceeds LINE_RHYTHM_MS. */
export const STAGGER_MS = 80;
export const LINE_RHYTHM_MS = 640;
/** Added after a word that ends a clause (`, ; :`), or a sentence when it is not the line's last word. */
export const PUNCT_HOLD_MS = 140;
/**
 * At most this many pauses in a line, so a name full of commas cannot stretch the moment past 5 seconds
 * (WCAG 2.2.2). Real names have one or two.
 */
export const MAX_HOLDS_PER_LINE = 2;
/** From the lead's last word landing to the follow's first word starting. */
export const LINE_GAP_MS = 360;
/** Stillness after the follow's last word lands. */
export const HOLD_MS = 1400;
/** The layer's fade out (easeOut; Townwise never eases in). */
export const EXIT_MS = 200;
/** Input this soon after the timeline starts is ignored, so the press or Enter that sent a request can't end it. */
export const GRACE_MS = 300;
/**
 * Web: after the last press on the layer lifts, the layer stays hit-testable until that press's click lands on it,
 * or this long if no click comes. A touch's click is hit-tested when the finger lifts, so a layer that let presses
 * through sooner would hand that click to the control underneath.
 */
export const CLICK_WAIT_MS = 350;
/** Reduced motion: both lines whole and still for this long, then the layer goes at once. */
export const REDUCED_HOLD_MS = 2400;

const CLAUSE_END = /[,;:]$/;
const SENTENCE_END = /[.!?]$/;

/** A line's words, split on whitespace. The overlay lays each out as its own view. */
export function wordsOf(line: string): string[] {
  return line.trim().split(/\s+/).filter((word) => word !== '');
}

/** Each word's start, from the line's start. */
export function wordDelays(words: readonly string[]): number[] {
  const stagger = words.length < 2 ? STAGGER_MS : Math.min(STAGGER_MS, Math.floor(LINE_RHYTHM_MS / (words.length - 1)));
  const delays: number[] = [];
  let at = 0;
  let holds = 0;
  words.forEach((word, index) => {
    delays.push(at);
    const last = index === words.length - 1;
    const pause = CLAUSE_END.test(word) || (!last && SENTENCE_END.test(word));
    if (pause && holds < MAX_HOLDS_PER_LINE) {
      at += PUNCT_HOLD_MS;
      holds += 1;
    }
    at += stagger;
  });
  return delays;
}

export interface Timeline {
  /** Each lead word's start. */
  lead: number[];
  /** Each follow word's start. */
  follow: number[];
  /** Each word's fade; 0 under reduced motion. */
  fadeMs: number;
  /** The follow's last word has landed; the clock stops here. */
  revealEndMs: number;
  /** The layer starts to leave. */
  exitAtMs: number;
  /** The layer's fade out; 0 under reduced motion, which removes it at once. */
  exitMs: number;
  /** The layer is gone. */
  doneAtMs: number;
}

export function timeline(statement: Statement, reduced: boolean): Timeline {
  const leadWords = wordsOf(statement.lead);
  const followWords = wordsOf(statement.follow);
  if (reduced) {
    return {
      lead: leadWords.map(() => 0), follow: followWords.map(() => 0), fadeMs: 0, revealEndMs: 0,
      exitAtMs: REDUCED_HOLD_MS, exitMs: 0, doneAtMs: REDUCED_HOLD_MS,
    };
  }
  const lead = wordDelays(leadWords).map((delay) => START_MS + delay);
  const leadLands = (lead.at(-1) ?? START_MS) + FADE_MS;
  const followStart = leadLands + LINE_GAP_MS;
  const follow = wordDelays(followWords).map((delay) => followStart + delay);
  const revealEndMs = (follow.at(-1) ?? followStart) + FADE_MS;
  const exitAtMs = revealEndMs + HOLD_MS;
  return { lead, follow, fadeMs: FADE_MS, revealEndMs, exitAtMs, exitMs: EXIT_MS, doneAtMs: exitAtMs + EXIT_MS };
}
