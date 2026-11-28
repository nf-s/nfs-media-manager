import { describe, expect, it } from 'vitest'
import { foldText, globContains } from '../src/fold'

describe('foldText', () => {
  it('lower-cases ASCII and leaves other characters', () => {
    expect(foldText('Example Track 01 (Live)')).toBe('example track 01 (live)')
  })

  it('maps U+0130 to a plain i, with no combining dot', () => {
    expect(foldText('İstanbul')).toBe('istanbul')
    expect([...foldText('İ')]).toHaveLength(1)
  })

  it('maps every capital sigma to U+03C3, with no final-sigma rule', () => {
    expect(foldText('ΟΔΟΣ')).toBe('οδοσ')
    expect(foldText('ΣΑΣ Σ')).toBe('σασ σ')
  })

  it('maps each code point one to one', () => {
    for (const sample of ['ÉTÉ', 'İIΣ', 'ẞ', 'A\u{10400}']) {
      expect([...foldText(sample)]).toHaveLength([...sample].length)
    }
    expect(foldText('ÉTÉ')).toBe('été')
    expect(foldText('ẞ')).toBe('ß')
    expect(foldText('A\u{10400}')).toBe('a\u{10428}')
  })

  it('builds a contains pattern with GLOB wildcards taken literally', () => {
    expect(globContains('Ab*C?[d]')).toBe('*ab[*]c[?][[]d]*')
  })

  it('keeps characters without a lowercase form', () => {
    expect(foldText('ß')).toBe('ß')
    expect(foldText('日本')).toBe('日本')
  })
})
