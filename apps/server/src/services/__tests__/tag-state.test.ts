import { describe, expect, it } from 'vitest'
import { PluginTagSchema } from '@repo/media-plugin-sdk'
import { normalizeTagName, tagDisplayName } from '@/services/tag-state'

describe('canonical tag names', () => {
  it('combines Unicode canonical equivalents, whitespace and case only', () => {
    expect(normalizeTagName('  CAF\u00c9\u00a0 Society\n')).toBe(
      'caf\u00e9 society',
    )
    expect(normalizeTagName('Cafe\u0301\u2003Society')).toBe(
      'caf\u00e9 society',
    )
    expect(tagDisplayName('  Caf\u00e9\tSociety ')).toBe('Caf\u00e9 Society')
    for (const [left, right] of [
      ['space-opera', 'space opera'],
      ['science fiction', 'science'],
      ['history of spain', 'spanish history'],
      ['caf\u00e9', 'cafe'],
      ['imdb.history-of-spain', 'history of spain'],
      ['\uff21', 'a'],
    ])
      expect(normalizeTagName(left ?? '')).not.toBe(
        normalizeTagName(right ?? ''),
      )
  })

  it('accepts old plugins and preserves optional provenance strings verbatim', () => {
    expect(PluginTagSchema.parse({ name: 'History' })).toEqual({
      name: 'History',
      kind: 'general',
    })
    const tag = {
      name: 'history of spain',
      kind: 'keyword',
      source: 'imdb',
      sourceId: '00042',
      rawName: ' imdb.history-of-spain ',
    }
    expect(PluginTagSchema.parse(tag)).toEqual(tag)
    expect(PluginTagSchema.safeParse({ ...tag, sourceId: 42 }).success).toBe(
      false,
    )
  })
})
