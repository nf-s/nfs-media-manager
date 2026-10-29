import { describe, expect, it } from 'vitest'
import {
  MergeTagsSchema,
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
    })
    for (const query of [
      { mediaType: 'music' },
      { page: 0 },
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
})
