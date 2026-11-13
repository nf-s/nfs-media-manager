import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlbumQuerySchema } from '@repo/schemas/media'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  queryBrowseIds: vi.fn(),
  tagOccurrences: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      mediaItem: { findMany: mocks.findMany, findFirst: mocks.findFirst },
    },
    select: () => ({ from: () => ({ where: mocks.tagOccurrences }) }),
  },
}))
vi.mock('@/services/browse', () => ({
  queryBrowseIds: mocks.queryBrowseIds,
  listBrowseFacets: vi.fn(),
}))
vi.mock('@/services/source-navigation', () => ({
  getCollectionSourceLinks: vi.fn(async () => []),
}))
vi.mock('@/services/album-provider-details', () => ({
  getAlbumProviderDetails: vi.fn(async () => ({})),
}))
vi.mock('@/services/album-playlists', () => ({
  albumTrackPlaylistNames: vi.fn(async () => new Map()),
}))
vi.mock('@/services/stored-trailers', () => ({
  withStoredTrailerLinks: vi.fn(),
}))

import { getAlbumDetail, listAlbums } from '@/services/media'
import { withRymRatingSourceLink } from './rym-rating-links'

const legacyUrl =
  'https://rateyourmusic.com/release/comp/fixture-band/radio-sampler/'
const ratingUrl =
  'https://rateyourmusic.com/release/album/fixture-band/fixture-album/'
const legacyLink = {
  provider: 'google-custom-search',
  label: 'RYM / Sonemic',
  url: legacyUrl,
}
const ratingLink = {
  provider: 'serply',
  label: 'Rate Your Music',
  url: ratingUrl,
}
const provenance = {
  source: 'rym',
  retrievalProvider: 'serply',
  matchStatus: 'rated',
  ratingSourceUrl: ratingUrl,
}
const metadata = {
  browse: { ratingRymValue: 3.6, ratingRymVotes: 12345 },
  'plugin.serply.provenance': provenance,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Live HTTP is forbidden')
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('RYM rating source links', () => {
  it('moves the exact rating source first without changing other links or their order', () => {
    const other = {
      provider: 'discogs',
      label: 'Discogs',
      url: 'https://www.discogs.com/master/123',
    }
    const selected = {
      ...ratingLink,
      url: 'https://rateyourmusic.com/release/album/fixture-band/selected/',
    }
    const links = [other, legacyLink, selected, ratingLink]
    const original = structuredClone(links)
    expect(
      withRymRatingSourceLink(links, {
        ...metadata,
        'plugin.serply.provenance': {
          ...provenance,
          sourceUrl: selected.url,
          releaseUrl: selected.url,
          genresSourceUrl: selected.url,
        },
      }),
    ).toEqual([ratingLink, other, legacyLink, selected])
    expect(links).toEqual(original)
  })

  it('supplies a missing rating source link and deduplicates only identical source URLs', () => {
    expect(withRymRatingSourceLink([legacyLink], metadata)).toEqual([
      ratingLink,
      legacyLink,
    ])
    expect(withRymRatingSourceLink([], metadata)).toEqual([ratingLink])
    expect(
      withRymRatingSourceLink(
        [
          legacyLink,
          ratingLink,
          { ...ratingLink, provider: 'imported-ratings' },
          legacyLink,
        ],
        metadata,
      ),
    ).toEqual([ratingLink, legacyLink, legacyLink])
  })

  it.each([
    ratingUrl,
    'https://rateyourmusic.com/release/album/fixture-band/reviews/',
    'https://rateyourmusic.com/release/album/fixture-band/lists/',
    'http://www.rateyourmusic.com/release/album/fixture-band/fixture-album/',
    'https://rateyourmusic.com/release/album/fixture-band/fixture-album.p/',
    'https://rateyourmusic.com/release/comp/various-artists/fixture/',
    'https://rateyourmusic.com/release/album/fixture-band/fixture-album/reviews/',
    'https://rateyourmusic.com/release/album/fixture-band/fixture-album/reviews/2/',
    'https://rateyourmusic.com/release/album/fixture-band/fixture-album/lists',
    'https://rateyourmusic.com/release/album/fixture-band/fixture-album/lists/3?sort=rating#ratings',
    'https://rateyourmusic.com/music-review/reviewer/fixture-band/fixture-album/12345',
  ])('preserves the exact valid source URL %s', (url) => {
    const result = withRymRatingSourceLink([legacyLink], {
      ...metadata,
      'plugin.serply.provenance': { ...provenance, ratingSourceUrl: url },
    })
    expect(result[0]?.url).toBe(url)
    expect(result[1]).toEqual(legacyLink)
  })

  it.each([
    'https://attacker.test/release/album/a/b/',
    'https://rateyourmusic.com.attacker.test/release/album/a/b/',
    'https://attacker.rateyourmusic.com/release/album/a/b/',
    'https://user:password@rateyourmusic.com/release/album/a/b/',
    'https://user@rateyourmusic.com/release/album/a/b/',
    'https://rateyourmusic.com:8443/release/album/a/b/',
    'http://rateyourmusic.com:8080/release/album/a/b/',
    'ftp://rateyourmusic.com/release/album/a/b/',
    'javascript:alert(1)',
    '/release/album/a/b/',
    '//rateyourmusic.com/release/album/a/b/',
    'https://rateyourmusic.com/artist/fixture-band',
    'https://rateyourmusic.com/',
    'https://rateyourmusic.com/release/album/a/b/reviews/not-a-page/',
    'https://rateyourmusic.com/release/album/a/b/reviews/2/extra/',
    'https://rateyourmusic.com/music-review/reviewer/a/b/not-an-id',
    'https://rateyourmusic.com/music-review/reviewer/a/b/123/lists/',
  ])(
    'leaves existing links unchanged for unsafe or unsupported source %s',
    (url) => {
      const links = [legacyLink, ratingLink]
      expect(
        withRymRatingSourceLink(links, {
          ...metadata,
          'plugin.serply.provenance': { ...provenance, ratingSourceUrl: url },
        }),
      ).toBe(links)
    },
  )

  it.each([0, 5])('accepts the current score boundary %s', (score) => {
    expect(
      withRymRatingSourceLink([legacyLink], {
        ...metadata,
        browse: { ratingRymValue: score },
      })[0],
    ).toEqual(ratingLink)
  })

  it.each([undefined, null, '3.6', -1, 5.1, Infinity, NaN])(
    'does not promote a source without a valid current numeric score: %s',
    (score) => {
      const links = [legacyLink, ratingLink]
      expect(
        withRymRatingSourceLink(links, {
          ...metadata,
          browse: { ratingRymValue: score },
        }),
      ).toBe(links)
    },
  )

  it.each([
    undefined,
    null,
    [],
    {},
    { browse: metadata.browse },
    { 'plugin.serply.provenance': provenance },
    { ...metadata, 'plugin.serply.provenance': [] },
    {
      ...metadata,
      'plugin.serply.provenance': { ...provenance, source: 'other' },
    },
    {
      ...metadata,
      'plugin.serply.provenance': { ...provenance, retrievalProvider: 'other' },
    },
    {
      ...metadata,
      'plugin.serply.provenance': {
        ...provenance,
        matchStatus: 'identity-only',
      },
    },
    {
      ...metadata,
      'plugin.serply.provenance': { ...provenance, matchStatus: 'genres-only' },
    },
    {
      ...metadata,
      'plugin.serply.provenance': { ...provenance, ratingSourceUrl: null },
    },
    {
      ...metadata,
      'plugin.serply.provenance': { ...provenance, ratingSourceUrl: 123 },
    },
    {
      ...metadata,
      'plugin.serply.provenance': {
        source: 'rym',
        retrievalProvider: 'serply',
        matchStatus: 'rated',
        sourceUrl: ratingUrl,
        releaseUrl: ratingUrl,
        manualReference: { referenceUrl: ratingUrl },
      },
    },
  ])(
    'preserves legacy fallback for invalid or unrated provenance %#',
    (value) => {
      const links = [legacyLink, ratingLink]
      expect(withRymRatingSourceLink(links, value)).toBe(links)
    },
  )
})

describe('album serializer RYM rating links', () => {
  it.each(['list', 'detail'])(
    'pairs the fresh score with its source and orders tags in the %s payload',
    async (view) => {
      const tag = { name: '', kind: 'genre', hidden: false }
      const record = {
        id: 'fixture-album',
        mediaType: 'album',
        slug: 'fixture-album',
        title: 'Fixture Album (Deluxe Edition)',
        originalTitle: null,
        summary: null,
        artworkUrl: null,
        releaseDate: null,
        sourceLabel: null,
        metadata,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        credits: [],
        tags: [
          { tagId: 'tag-year', tag: { ...tag, name: '2026' } },
          { tagId: 'tag-ambient', tag: { ...tag, name: 'ambient' } },
          { tagId: 'tag-house', tag: { ...tag, name: 'House' } },
          { tagId: 'tag-hidden', tag: { ...tag, name: 'aaa', hidden: true } },
        ],
        links: [ratingLink, legacyLink],
        providerReferences: [],
        playlistItems: [],
        album: {
          metadata: {},
          dateAdded: null,
          durationSec: null,
          spotifyUrl: null,
          trackCount: null,
          tracks: [],
        },
      }
      mocks.findMany.mockResolvedValue([record])
      mocks.findFirst.mockResolvedValue(record)
      mocks.tagOccurrences.mockResolvedValue([
        { mediaItemId: record.id, tagId: 'tag-house' },
      ])
      mocks.queryBrowseIds.mockResolvedValue({
        ids: [record.id],
        totalCount: 1,
        pageCount: 1,
      })
      const item =
        view === 'list'
          ? (await listAlbums(AlbumQuerySchema.parse({}))).items[0]
          : await getAlbumDetail(record.id)
      expect(item?.metadata?.browse).toEqual(metadata.browse)
      expect(item?.links[0]).toEqual(ratingLink)
      expect(item?.links).toContainEqual(legacyLink)
      // The Rate Your Music genre leads; the year tag comes last.
      expect(item?.tags.map((entry) => entry.name)).toEqual([
        'House',
        'ambient',
        '2026',
      ])
      expect(globalThis.fetch).not.toHaveBeenCalled()
    },
  )
})
