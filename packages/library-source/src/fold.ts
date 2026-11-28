const DOTTED_CAPITAL_I = 0x130
const CAPITAL_SIGMA = 0x3a3
/** The only code points whose `toLowerCase` differs from the simple mapping. */
const CONTEXT_CHARACTERS = /[İΣ]/u

/**
 * Case folding as PostgreSQL `lower()` gives it in a `C.UTF-8` database:
 * the simple one-to-one lowercase mapping of each code point. U+0130 maps to
 * U+0069 without a combining dot, a capital sigma is always U+03C3 (no
 * final-sigma context) and nothing expands to several characters.
 *
 * Applied to stored values when a row is written and to query values when
 * they are bound, so SQL compares folded text by code point.
 */
/**
 * A GLOB pattern that matches any value containing `word` once folded, with
 * the GLOB wildcards in the word taken literally. Bind it to
 * `folded GLOB ?` on an FTS table, which reads the trigram index when the
 * word has three or more characters.
 */
export function globContains(word: string): string {
  return `*${foldText(word).replace(/[*?[]/gu, '[$&]')}*`
}

export function foldText(value: string): string {
  if (!CONTEXT_CHARACTERS.test(value)) return value.toLowerCase()
  let folded = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === DOTTED_CAPITAL_I) folded += 'i'
    else if (codePoint === CAPITAL_SIGMA) folded += 'σ'
    else folded += character.toLowerCase()
  }
  return folded
}
