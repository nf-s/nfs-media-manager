import { z } from 'zod'
import { DeviceFoldRowSchema, type DeviceFoldRow } from '@repo/schemas/device'
import type { SqliteExecutor } from './driver'

/**
 * Case folding as the server's PostgreSQL `lower()` gives it, from the `meta`
 * row `fold` the server publishes (DEVICE-26): for each code point its
 * database changes, the result. The device folds with this mapping and with
 * nothing of its own engine, whose Unicode version may differ from the
 * database's.
 *
 * Applied to stored values when a row is written and to query values when
 * they are bound, so SQL compares folded text by code point.
 */
export type TextFold = {
  /** `lower(chr(c))` of each code point `c` the database changes. */
  readonly lower: ReadonlyMap<number, string>
  /** The code points the results consist of: lower-case letters as the database knows them. */
  readonly yields: ReadonlySet<number>
  /** One code point of `lower`, or a lone surrogate. */
  readonly pattern: RegExp
  /** The row's JSON, to tell a changed mapping from the stored one. */
  readonly source: string
}

const REPLACEMENT = '�'
const DOTTED_CAPITAL_I = 0x130
const CAPITAL_SIGMA = 0x3a3
const FINAL_SIGMA = 0x3c2

function isSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff
}

function codePointClass(codePoints: readonly number[]): string {
  const ranges: string[] = []
  let index = 0
  while (index < codePoints.length) {
    const start = codePoints[index] ?? 0
    let end = start
    while (codePoints[index + 1] === end + 1) {
      index += 1
      end += 1
    }
    const hex = (codePoint: number) => `\\u{${codePoint.toString(16)}}`
    ranges.push(start === end ? hex(start) : `${hex(start)}-${hex(end)}`)
    index += 1
  }
  return ranges.join('')
}

/** The mapping of a parsed `fold` row. */
export function createTextFold(row: DeviceFoldRow): TextFold {
  const lower = new Map<number, string>()
  const yields = new Set<number>()
  row.codePoints.forEach((codePoint, index) => {
    const result = row.lower[index] ?? ''
    lower.set(codePoint, result)
    for (const character of result) yields.add(character.codePointAt(0) ?? 0)
  })
  return {
    lower,
    yields,
    pattern: new RegExp(
      `[${codePointClass(row.codePoints)}\\u{d800}-\\u{dfff}]`,
      'gu',
    ),
    source: JSON.stringify({ codePoints: row.codePoints, lower: row.lower }),
  }
}

/**
 * `lower(value)` in the server's database: each code point through the
 * mapping. A lone surrogate becomes U+FFFD, as the server's UTF-8 encoding
 * of a query value sends it.
 */
export function foldText(value: string, fold: TextFold): string {
  return value.replace(fold.pattern, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return isSurrogate(codePoint)
      ? REPLACEMENT
      : (fold.lower.get(codePoint) ?? character)
  })
}

/**
 * A GLOB pattern that matches any value containing `word` once folded, with
 * the GLOB wildcards in the word taken literally. Bind it to
 * `folded GLOB ?` on an FTS table, which reads the trigram index when the
 * word has three or more characters.
 */
export function globContains(word: string, fold: TextFold): string {
  return `*${foldText(word, fold).replace(/[*?[]/gu, '[$&]')}*`
}

/**
 * `value.toLowerCase()` as the server's JavaScript engine gives it, where a
 * service lower-cases a value in TypeScript; `undefined` when the mapping
 * cannot settle it. Settled: ASCII; U+0130, which ECMAScript maps to `i`
 * and a combining dot; a code point the database changes to one code
 * point, which the engine changes alike as long as it knows at least the
 * database's Unicode version; a lower-case letter the database yields,
 * and U+03C2, which do not change. Unsettled: a capital sigma (the engine
 * applies the final-sigma rule), a lone surrogate, a code point the
 * database changes to several, and any other code point outside ASCII,
 * which a newer Unicode may give a lower-case form the database lacks.
 */
export function lowerCaseAsServer(
  value: string,
  fold: TextFold,
): string | undefined {
  let lowered = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const mapped = fold.lower.get(codePoint)
    if (codePoint === DOTTED_CAPITAL_I) lowered += 'i̇'
    else if (codePoint === CAPITAL_SIGMA || isSurrogate(codePoint))
      return undefined
    else if (mapped !== undefined) {
      if ([...mapped].length !== 1) return undefined
      lowered += mapped
    } else if (
      codePoint < 0x80 ||
      codePoint === FINAL_SIGMA ||
      fold.yields.has(codePoint)
    )
      lowered += character
    else return undefined
  }
  return lowered
}

/**
 * `value.toLowerCase() === label.toLowerCase()` on the server, for an ASCII
 * label. A value the mapping cannot settle holds a code point whose lower
 * case is outside ASCII on any engine, so it equals no label.
 */
export function equalsLabelAsServer(
  value: string,
  label: string,
  fold: TextFold,
): boolean {
  const lowered = lowerCaseAsServer(value, fold)
  return lowered !== undefined && lowered === lowerCaseAsServer(label, fold)
}

const FoldMetaSchema = z.object({ seq: z.number().int(), value: z.string() })
const FOLD_ID = 'fold'

/** The stored `fold` row's `seq` and JSON, or undefined when the store has none. */
export async function readFoldRow(
  tx: SqliteExecutor,
): Promise<z.infer<typeof FoldMetaSchema> | undefined> {
  const [row] = await tx.all('SELECT seq, value FROM meta WHERE id = ?', [
    FOLD_ID,
  ])
  return row === undefined ? undefined : FoldMetaSchema.parse(row)
}

/** The stored mapping; undefined when the store has none. */
export async function readTextFold(
  tx: SqliteExecutor,
): Promise<TextFold | undefined> {
  const row = await readFoldRow(tx)
  return row === undefined ? undefined : parseTextFold(row.value)
}

export function parseTextFold(json: string): TextFold {
  const meta = DeviceFoldRowSchema.parse(JSON.parse(json))
  return createTextFold(meta)
}

export function isFoldRow(entity: string, id: string): boolean {
  return entity === 'meta' && id === FOLD_ID
}
