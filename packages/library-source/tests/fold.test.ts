import { describe, expect, it } from 'vitest'
import {
  createTextFold,
  equalsLabelAsServer,
  foldText,
  globContains,
  lowerCaseAsServer,
} from '../src/fold'
import { testFold } from './fixtures'

describe('foldText', () => {
  it('lower-cases ASCII and leaves other characters', () => {
    expect(foldText('Example Track 01 (Live)', testFold)).toBe(
      'example track 01 (live)',
    )
  })

  it('folds with the published mapping only', () => {
    // A server whose database maps nothing but A: the engine's own
    // lower case of other letters is never used.
    const onlyA = createTextFold({
      kind: 'fold',
      codePoints: [0x41],
      lower: ['a'],
    })
    expect(foldText('ABC É', onlyA)).toBe('aBC É')
    // A database whose lower() yields two characters is kept as it is.
    const expanding = createTextFold({
      kind: 'fold',
      codePoints: [0x130],
      lower: ['i̇'],
    })
    expect(foldText('İX', expanding)).toBe('i̇X')
  })

  it('maps U+0130 as the mapping does, here to a plain i', () => {
    expect(foldText('İstanbul', testFold)).toBe('istanbul')
    expect([...foldText('İ', testFold)]).toHaveLength(1)
  })

  it('maps every capital sigma to U+03C3, with no final-sigma rule', () => {
    expect(foldText('ΟΔΟΣ', testFold)).toBe('οδοσ')
    expect(foldText('ΣΑΣ Σ', testFold)).toBe('σασ σ')
  })

  it('maps each code point one to one with a one-character mapping', () => {
    for (const sample of ['ÉTÉ', 'İIΣ', 'ẞ', 'A\u{10400}']) {
      expect([...foldText(sample, testFold)]).toHaveLength([...sample].length)
    }
    expect(foldText('ÉTÉ', testFold)).toBe('été')
    expect(foldText('ẞ', testFold)).toBe('ß')
    expect(foldText('A\u{10400}', testFold)).toBe('a\u{10428}')
  })

  it('turns a lone surrogate into U+FFFD, as the server receives it', () => {
    expect(foldText('a\ud800B', testFold)).toBe('a�b')
  })

  it('builds a contains pattern with GLOB wildcards taken literally', () => {
    expect(globContains('Ab*C?[d]', testFold)).toBe('*ab[*]c[?][[]d]*')
  })

  it('keeps characters the mapping does not change', () => {
    expect(foldText('ß', testFold)).toBe('ß')
    expect(foldText('日本', testFold)).toBe('日本')
  })
})

describe('lowerCaseAsServer', () => {
  it('settles ASCII, mapped letters and the lower-case letters they yield', () => {
    expect(lowerCaseAsServer('Café NOIR', testFold)).toBe('café noir')
    expect(lowerCaseAsServer('ΣΟΦΙα σας', testFold)).toBeUndefined()
    expect(lowerCaseAsServer('σοφια σας', testFold)).toBe('σοφια σας')
  })

  it('gives U+0130 the dotted i that ECMAScript gives', () => {
    expect(lowerCaseAsServer('İstanbul', testFold)).toBe('i̇stanbul')
  })

  it('leaves unsettled what a newer Unicode might map', () => {
    expect(lowerCaseAsServer('Ᲊ', testFold)).toBeUndefined()
    expect(lowerCaseAsServer('日本', testFold)).toBeUndefined()
    expect(lowerCaseAsServer('a\ud800', testFold)).toBeUndefined()
    expect(lowerCaseAsServer('Σ', testFold)).toBeUndefined()
  })

  it('matches ASCII labels as the server does', () => {
    expect(equalsLabelAsServer('LAST.FM', 'Last.fm', testFold)).toBe(true)
    // The Kelvin sign lower-cases to k on any engine and in the mapping.
    expect(equalsLabelAsServer('Key', 'key', testFold)).toBe(true)
    // ECMAScript adds a combining dot to U+0130, so it is no plain i.
    expect(equalsLabelAsServer('LİKED', 'liked', testFold)).toBe(false)
    expect(equalsLabelAsServer('Ᲊ', 'Ᲊ', testFold)).toBe(false)
  })
})
