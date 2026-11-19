import { describe, expect, it } from 'vitest'
import {
  CreateTagSchema,
  formatTagName,
  normalizeTagName,
  MergeTagsSchema,
  SetTagParentsSchema,
  TagListQuerySchema,
  TagSchema,
  SetTagVisibilitySchema,
  TagDetailQuerySchema,
  TagProvenanceQuerySchema,
} from '../src/tags'

describe('tag contracts', () => {
  it('validates pagination, source uniqueness and a distinct target', () => {
    expect(TagListQuerySchema.parse({})).toEqual({
      mediaType: 'film',
      page: 1,
      size: 25,
      visibility: 'visible',
      placement: 'any',
      sortBy: 'name',
      direction: 'asc',
    })
    for (const query of [
      { mediaType: 'music' },
      { page: 0 },
      { sortBy: 'unknown' },
      { direction: 'sideways' },
      { placement: 'nowhere' },
      { size: 101 },
      { size: 1.5 },
      { q: 'x'.repeat(201) },
    ])
      expect(TagListQuerySchema.safeParse(query).success).toBe(false)
    for (const input of [
      { sourceIds: [], targetId: 'b' },
      { sourceIds: ['a', 'a'], targetId: 'b' },
      { sourceIds: ['a'], targetId: 'a' },
    ])
      expect(
        MergeTagsSchema.safeParse({ mediaType: 'film', ...input }).success,
      ).toBe(false)
    expect(
      MergeTagsSchema.parse({
        mediaType: 'album',
        sourceIds: ['a'],
        targetId: 'b',
      }),
    ).toEqual({
      mediaType: 'album',
      sourceIds: ['a'],
      targetId: 'b',
    })
  })

  it('validates explicit visibility and bounded unique tag selections', () => {
    for (const visibility of ['visible', 'hidden', 'all'])
      expect(TagListQuerySchema.parse({ visibility }).visibility).toBe(
        visibility,
      )
    expect(TagListQuerySchema.safeParse({ visibility: 'true' }).success).toBe(
      false,
    )
    expect(TagDetailQuerySchema.parse({ mediaType: 'album' })).toEqual({
      mediaType: 'album',
      page: 1,
      size: 25,
    })
    expect(
      TagDetailQuerySchema.safeParse({ mediaType: 'film', size: 101 }).success,
    ).toBe(false)
    for (const input of [
      { tagIds: [], hidden: true },
      { tagIds: ['a', 'a'], hidden: true },
      { tagIds: [''], hidden: true },
      { tagIds: ['a'], hidden: 'false' },
      { tagIds: ['a'] },
      {
        tagIds: Array.from({ length: 101 }, (_, index) => String(index)),
        hidden: false,
      },
    ])
      expect(
        SetTagVisibilitySchema.safeParse({ mediaType: 'film', ...input })
          .success,
      ).toBe(false)
    expect(
      SetTagVisibilitySchema.parse({
        mediaType: 'album',
        tagIds: ['a'],
        hidden: false,
      }),
    ).toEqual({ mediaType: 'album', tagIds: ['a'], hidden: false })
  })

  it('represents unknown provenance without inventing a provider', () => {
    expect(
      TagSchema.parse({
        mediaType: 'film',
        id: 'tag',
        name: 'History',
        kind: 'genre',
        mediaCount: 1,
        sourceCount: 1,
        sources: [
          { provider: null, source: null, rawName: 'History', kind: 'genre' },
        ],
      }).sources[0]?.provider,
    ).toBeNull()
  })

  it('requires scope for mutations, detail and non-item provenance', () => {
    expect(
      MergeTagsSchema.safeParse({ sourceIds: ['a'], targetId: 'b' }).success,
    ).toBe(false)
    expect(
      SetTagVisibilitySchema.safeParse({ tagIds: ['a'], hidden: false })
        .success,
    ).toBe(false)
    expect(TagDetailQuerySchema.safeParse({}).success).toBe(false)
    expect(TagProvenanceQuerySchema.safeParse({ name: 'Shared' }).success).toBe(
      false,
    )
    expect(
      TagProvenanceQuerySchema.safeParse({
        name: 'Shared',
        mediaId: 'album-id',
      }).success,
    ).toBe(true)
    expect(
      TagProvenanceQuerySchema.safeParse({ name: 'Shared', mediaType: 'album' })
        .success,
    ).toBe(true)
  })

  it('validates parent changes and new tags', () => {
    const base = { mediaType: 'album', tagIds: ['a'] }
    for (const input of [
      { ...base, parentIds: ['p'], mode: 'add' },
      { ...base, parentIds: ['p'], mode: 'remove' },
      { ...base, parentIds: [], mode: 'replace' },
    ])
      expect(SetTagParentsSchema.safeParse(input).success).toBe(true)
    for (const input of [
      { ...base, parentIds: [], mode: 'add' },
      { ...base, parentIds: [], mode: 'remove' },
      { ...base, parentIds: ['a'], mode: 'add' },
      { ...base, parentIds: ['p', 'p'], mode: 'replace' },
      { ...base, tagIds: ['a', 'a'], parentIds: ['p'], mode: 'add' },
      { ...base, tagIds: [], parentIds: ['p'], mode: 'add' },
      { ...base, parentIds: ['p'], mode: 'move' },
    ])
      expect(SetTagParentsSchema.safeParse(input).success).toBe(false)
    expect(
      CreateTagSchema.parse({ mediaType: 'film', name: 'Setting' }),
    ).toEqual({ mediaType: 'film', name: 'Setting', parentIds: [] })
    for (const name of ['', '  \u00a0 ', 'x'.repeat(201)])
      expect(
        CreateTagSchema.safeParse({ mediaType: 'film', name }).success,
      ).toBe(false)
  })

  it('a tag name is shown in title case whatever case it was stored in', () => {
    for (const [stored, shown] of [
      ['indie rock', 'Indie Rock'],
      ['Indie Rock', 'Indie Rock'],
      ['INDIE ROCK', 'Indie Rock'],
      ['  dream   pop ', 'Dream Pop'],
      ['gangster', 'Gangster'],
      ['1980s', '1980s'],
      ['60s pop', '60s Pop'],
      ['夜の港', '夜の港'],
      ['música popular brasileira', 'Música Popular Brasileira'],
      ['ßtraße', 'ßtraße'],
      ['', ''],
    ] as const)
      expect(formatTagName(stored)).toBe(shown)
  })

  it('minor words stay in lower case inside a name only', () => {
    for (const [stored, shown] of [
      ['based on novel or book', 'Based on Novel or Book'],
      ['coming of age', 'Coming of Age'],
      ['drum and bass', 'Drum and Bass'],
      ['the beatles', 'The Beatles'],
      ['sleeping in', 'Sleeping In'],
      ['man vs. nature', 'Man vs. Nature'],
      ['rock-and-roll', 'Rock-and-Roll'],
      ['rio de janeiro', 'Rio de Janeiro'],
      ["rock 'n' roll", "Rock 'n' Roll"],
      ["women's rights", "Women's Rights"],
      ['love, and other drugs', 'Love, and Other Drugs'],
      ['artist (the band)', 'Artist (The Band)'],
    ] as const)
      expect(formatTagName(stored)).toBe(shown)
  })

  it('joined words and abbreviations keep their usual capitals', () => {
    for (const [stored, shown] of [
      ['lo-fi', 'Lo-Fi'],
      ['post-punk', 'Post-Punk'],
      ['singer/songwriter', 'Singer/Songwriter'],
      ['r&b', 'R&B'],
      ['rnb', 'RnB'],
      ['k-pop', 'K-Pop'],
      ['hi-nrg', 'Hi-NRG'],
      ['uk garage', 'UK Garage'],
      ['edm', 'EDM'],
      ['tv movie', 'TV Movie'],
      ['world war ii', 'World War II'],
      ['lgbtq+ stories', 'LGBTQ+ Stories'],
      ['artificial intelligence (a.i.)', 'Artificial Intelligence (A.I.)'],
      ['sci-fi', 'Sci-Fi'],
      ['2-step', '2-Step'],
      ['3d', '3D'],
    ] as const)
      expect(formatTagName(stored)).toBe(shown)
  })

  it('formatting only changes letter case', () => {
    for (const stored of [
      'Rock & Roll',
      'ambient  atmospheric house',
      'İstanbul',
    ])
      expect(formatTagName(stored).toLowerCase()).toBe(normalizeTagName(stored))
  })
})
