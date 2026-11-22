import { afterEach, describe, expect, it } from 'vitest'
import { formatBrowseFilterValue, trackBrowseFields } from '../src/browse'
import {
  defaultKeyNotation,
  formatMusicalKey,
  parseMusicalKey,
  setKeyDisplayNotation,
} from '../src/musical-keys'

describe('musical keys', () => {
  afterEach(() => setKeyDisplayNotation(defaultKeyNotation))

  it('writes every Camelot key in the three notations', () => {
    expect(formatMusicalKey('8A', 'musical')).toBe('Am')
    expect(formatMusicalKey('8A', 'open')).toBe('1m')
    expect(formatMusicalKey('8B', 'musical')).toBe('C')
    expect(formatMusicalKey('8B', 'open')).toBe('1d')
    expect(formatMusicalKey('1A', 'musical')).toBe('Abm')
    expect(formatMusicalKey('1A', 'open')).toBe('6m')
    expect(formatMusicalKey('12B', 'open')).toBe('5d')
    expect(formatMusicalKey('11A', 'camelot')).toBe('11A')
    expect(formatMusicalKey('13C', 'musical')).toBe('13C')
  })

  it('reads a key written in any notation back as its Camelot key', () => {
    for (let number = 1; number <= 12; number++)
      for (const letter of ['A', 'B']) {
        const camelot = `${number}${letter}`
        expect(parseMusicalKey(formatMusicalKey(camelot, 'musical'))).toBe(
          camelot,
        )
        expect(parseMusicalKey(formatMusicalKey(camelot, 'open'))).toBe(camelot)
        expect(parseMusicalKey(camelot.toLowerCase())).toBe(camelot)
      }
    expect(parseMusicalKey('G# minor')).toBe('1A')
    expect(parseMusicalKey('C♯m')).toBe('12A')
    expect(parseMusicalKey('E major')).toBe('12B')
    expect(parseMusicalKey('H')).toBeNull()
    expect(parseMusicalKey('')).toBeNull()
  })

  it('shows Browse key values in the chosen notation', () => {
    expect(trackBrowseFields.map((field) => field.key)).toEqual(
      expect.arrayContaining(['bpm', 'musicalKey']),
    )
    setKeyDisplayNotation('open')
    expect(formatBrowseFilterValue('musicalKey', '9A')).toBe('2m')
    setKeyDisplayNotation('musical')
    expect(formatBrowseFilterValue('musicalKey', '9A')).toBe('Em')
    expect(formatBrowseFilterValue('album', '9A')).toBe('9A')
  })
})
