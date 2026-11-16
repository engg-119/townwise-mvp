// A sentence in parts, with its key figures marked strong: Home draws those bold (owner request, 2026-11-15). Joined,
// the parts are the sentence's plain words, which each string line function returns and screen readers read as one.

export type Phrase = readonly (string | { readonly strong: string })[];

/** A key figure of a phrase, drawn bold. */
export function strong(text: string): { readonly strong: string } {
  return { strong: text };
}

/** The phrase as plain words. */
export function plainOf(phrase: Phrase): string {
  return phrase.map((part) => (typeof part === 'string' ? part : part.strong)).join('');
}
