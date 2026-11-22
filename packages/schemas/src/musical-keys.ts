import { z } from 'zod'

/** How a track's key is written: musical (`Am`), Camelot (`8A`) or Open Key (`1m`). */
export const KeyNotationSchema = z.enum(['musical', 'camelot', 'open'])
export type KeyNotation = z.infer<typeof KeyNotationSchema>

export const keyNotationLabels: Record<KeyNotation, string> = {
  musical: 'Musical',
  camelot: 'Camelot',
  open: 'Open Key',
}

export const defaultKeyNotation: KeyNotation = 'musical'

// Camelot wheel positions 1 to 12: the minor key (A) and its relative major (B).
const minorKeys = [
  'Abm',
  'Ebm',
  'Bbm',
  'Fm',
  'Cm',
  'Gm',
  'Dm',
  'Am',
  'Em',
  'Bm',
  'F#m',
  'Dbm',
]
const majorKeys = [
  'B',
  'F#',
  'Db',
  'Ab',
  'Eb',
  'Bb',
  'F',
  'C',
  'G',
  'D',
  'A',
  'E',
]
// Sharps and flats that name the same key as the spelling above.
const enharmonics: Record<string, string> = {
  'G#': 'Ab',
  'D#': 'Eb',
  'A#': 'Bb',
  Gb: 'F#',
  'C#': 'Db',
  Cb: 'B',
  Fb: 'E',
  'E#': 'F',
  'B#': 'C',
}

export const CamelotKeySchema = z
  .string()
  .regex(/^(1[0-2]|[1-9])[AB]$/, 'Expected a Camelot key such as 8A')
export type CamelotKey = z.infer<typeof CamelotKeySchema>

function wheel(camelot: string) {
  const parsed = CamelotKeySchema.safeParse(camelot)
  if (!parsed.success) return null
  return {
    number: Number.parseInt(parsed.data.slice(0, -1), 10),
    minor: parsed.data.endsWith('A'),
  }
}

/** A Camelot key in the chosen notation; an unknown value is returned unchanged. */
export function formatMusicalKey(camelot: string, notation: KeyNotation) {
  const position = wheel(camelot)
  if (!position) return camelot
  if (notation === 'camelot') return camelot
  if (notation === 'open')
    return `${((position.number + 4) % 12) + 1}${position.minor ? 'm' : 'd'}`
  return (
    (position.minor ? minorKeys : majorKeys)[position.number - 1] ?? camelot
  )
}

/** The Camelot key written in any of the three notations, or null. */
export function parseMusicalKey(value: string): CamelotKey | null {
  const text = value.trim().replace(/♯/gu, '#').replace(/♭/gu, 'b')
  const camelot = /^(1[0-2]|[1-9])([ab])$/iu.exec(text)
  if (camelot) return `${camelot[1]}${camelot[2]?.toUpperCase()}`
  const open = /^(1[0-2]|[1-9])([md])$/iu.exec(text)
  if (open) {
    const number = ((Number.parseInt(open[1] ?? '', 10) + 6) % 12) + 1
    return `${number}${open[2]?.toLowerCase() === 'm' ? 'A' : 'B'}`
  }
  const musical =
    /^([a-g])([#b]?)\s*(m|min|minor|maj|major)?$/iu.exec(text) ?? null
  if (!musical) return null
  const pitch = `${musical[1]?.toUpperCase()}${musical[2] ?? ''}`
  const spelled = enharmonics[pitch] ?? pitch
  const minor = /^m(in(or)?)?$/iu.test(musical[3] ?? '')
  const index = (minor ? minorKeys : majorKeys).indexOf(
    minor ? `${spelled}m` : spelled,
  )
  return index < 0 ? null : `${index + 1}${minor ? 'A' : 'B'}`
}

// Browse formats values outside React; the web sets the reader's choice here.
let displayNotation: KeyNotation = defaultKeyNotation

export function setKeyDisplayNotation(notation: KeyNotation) {
  displayNotation = notation
}

export function keyDisplayNotation(): KeyNotation {
  return displayNotation
}
