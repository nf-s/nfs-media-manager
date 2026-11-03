import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginReference } from '@repo/media-plugin-sdk'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core'

const mocks = vi.hoisted(() => ({
  rows: vi.fn<() => Promise<Array<{ provider: string; url: string }>>>(),
  read: vi.fn<
    (
      table: PgTable | undefined,
      selection: object,
      where: SQL | undefined,
      order: SQL[],
      limit: number,
    ) => void
  >(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    select: (selection: object) => {
      let table: PgTable | undefined
      let condition: SQL | undefined
      let order: SQL[] = []
      const builder = {
        from: (source: PgTable) => {
          table = source
          return builder
        },
        where: (where: SQL | undefined) => {
          condition = where
          return builder
        },
        getSQL: (): SQL => sql`select 1 from ${table} where ${condition}`,
        orderBy: (...columns: SQL[]) => {
          order = columns
          return builder
        },
        limit: (limit: number) => {
          mocks.read(table, selection, condition, order, limit)
          return mocks.rows()
        },
      }
      return builder
    },
  },
}))

import { getProviderReferenceHints } from '../provider-reference-hints'
import { externalLink } from '@/schemas/db'

const release =
  'https://rateyourmusic.com/release/album/fixture-artist/fixture-album/'
const review =
  'https://rateyourmusic.com/music-review/fixture-user/fixture-artist/fixture-album/1/'
const input = {
  provider: 'serply',
  mediaType: 'album',
  mediaItemId: 'fixture-album',
  existingReferences: [],
} satisfies Parameters<typeof getProviderReferenceHints>[0]

beforeEach(() => {
  vi.resetAllMocks()
  mocks.rows.mockResolvedValue([])
})

describe('legacy RYM context hints', () => {
  it('reads only bounded legacy URL rows for the selected album', async () => {
    await getProviderReferenceHints(input)
    expect(mocks.read).toHaveBeenCalledOnce()
    const read = mocks.read.mock.calls[0]
    if (!read?.[2]) throw new Error('Missing bounded link lookup')
    const [table, selection, condition, order, limit] = read
    expect(table).toBe(externalLink)
    expect(selection).toEqual({
      provider: externalLink.provider,
      url: externalLink.url,
    })
    const query = new PgDialect().sqlToQuery(condition)
    expect(query.sql).toContain('"external_link"."media_item_id" =')
    expect(query.sql).toContain('"external_link"."provider" in')
    expect(query.params).toEqual([
      'fixture-album',
      'google-custom-search',
      'legacy-browser',
    ])
    expect(order).toHaveLength(1)
    expect(limit).toBe(8)
  })

  it('returns non-primary context hints with original source attribution, not Serply ownership', async () => {
    mocks.rows.mockResolvedValue([
      { provider: 'google-custom-search', url: release },
      { provider: 'legacy-browser', url: review },
    ])
    expect(await getProviderReferenceHints(input)).toEqual([
      {
        referenceType: 'rym-url',
        externalId: release,
        isPrimary: false,
        metadata: { sourceProvider: 'google-custom-search', searchHint: true },
      },
      {
        referenceType: 'rym-url',
        externalId: review,
        isPrimary: false,
        metadata: { sourceProvider: 'legacy-browser', searchHint: true },
      },
    ])
    expect(input.existingReferences).toEqual([])
  })

  it('deduplicates identical links while retaining the first source', async () => {
    mocks.rows.mockResolvedValue([
      { provider: 'google-custom-search', url: release },
      { provider: 'legacy-browser', url: release },
    ])
    expect(await getProviderReferenceHints(input)).toHaveLength(1)
  })

  it.each([
    'reviews',
    'reviews/',
    'reviews/1',
    'reviews/1/',
    'lists',
    'lists/',
    'lists/12',
    'lists/12/',
  ])(
    'normalizes a legacy release child page before validating: %s',
    async (suffix) => {
      mocks.rows.mockResolvedValue([
        { provider: 'google-custom-search', url: `${release}${suffix}` },
      ])
      expect(await getProviderReferenceHints(input)).toEqual([
        {
          referenceType: 'rym-url',
          externalId: release,
          isPrimary: false,
          metadata: {
            sourceProvider: 'google-custom-search',
            searchHint: true,
          },
        },
      ])
    },
  )

  it.each(['reviews', 'lists'])(
    'preserves a release whose actual title slug is %s',
    async (title) => {
      const url = `https://rateyourmusic.com/release/album/fixture-artist/${title}/`
      mocks.rows.mockResolvedValue([{ provider: 'legacy-browser', url }])
      expect(await getProviderReferenceHints(input)).toMatchObject([
        { externalId: url },
      ])
    },
  )

  it.each([
    'https://example.com/release/album/fixture-artist/fixture-album/',
    'https://rateyourmusic.com.example.com/release/album/fixture-artist/fixture-album/',
    'https://rateyourmusic.com/artist/fixture-artist/',
    'https://rateyourmusic.com/list/fixture-user/list/',
    'https://rateyourmusic.com/',
    'https://secret@rateyourmusic.com/release/album/fixture-artist/fixture-album/',
    'javascript:alert(1)',
    'not a URL',
    `${release}reviews/not-a-page/`,
    `${release}unknown/1/`,
    'https://example.com/release/album/fixture-artist/fixture-album/reviews/1/',
    'https://rateyourmusic.com/artist/fixture-artist/reviews/1/',
  ])('ignores an invalid album URL: %s', async (url) => {
    mocks.rows.mockResolvedValue([{ provider: 'google-custom-search', url }])
    expect(await getProviderReferenceHints(input)).toEqual([])
  })

  it('ignores unexpected source providers even if a returned URL validates', async () => {
    mocks.rows.mockResolvedValue([{ provider: 'serply', url: release }])
    expect(await getProviderReferenceHints(input)).toEqual([])
  })

  it.each(['serply', 'google-custom-search', 'manual'])(
    'preserves existing %s RYM references without reading links',
    async (sourceProvider) => {
      const reference: PluginReference = {
        referenceType: 'rym-url',
        externalId: release,
        isPrimary: true,
        metadata: { sourceProvider },
      }
      const existingReferences = [reference]
      expect(
        await getProviderReferenceHints({ ...input, existingReferences }),
      ).toEqual([])
      expect(existingReferences).toEqual([reference])
      expect(mocks.read).not.toHaveBeenCalled()
    },
  )

  it('does not replace an invalid existing RYM reference with a legacy hint', async () => {
    expect(
      await getProviderReferenceHints({
        ...input,
        existingReferences: [{ referenceType: 'rym-url' }],
      }),
    ).toEqual([])
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('allows hints alongside unrelated identifiers without changing them', async () => {
    mocks.rows.mockResolvedValue([{ provider: 'legacy-browser', url: release }])
    const existingReferences = [{ referenceType: 'spotify-album-id' }]
    expect(
      await getProviderReferenceHints({ ...input, existingReferences }),
    ).toHaveLength(1)
    expect(existingReferences).toEqual([{ referenceType: 'spotify-album-id' }])
  })

  it('skips other providers and films without querying', async () => {
    expect(
      await getProviderReferenceHints({ ...input, provider: 'spotify' }),
    ).toEqual([])
    expect(
      await getProviderReferenceHints({ ...input, mediaType: 'film' }),
    ).toEqual([])
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
