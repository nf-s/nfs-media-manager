import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { BrowseFacetQuerySchema } from '@repo/schemas/browse'
import { ArtistQuerySchema } from '@repo/schemas/creators'
import type { ListeningPeriod } from '@repo/schemas/listening'
import { AlbumQuerySchema, FilmQuerySchema } from '@repo/schemas/media'
import {
  PlaylistBrowseQuerySchema,
  TrackPositionsQuerySchema,
  TrackQuerySchema,
} from '@repo/schemas/tracks'
import {
  createRemoteLibrarySource,
  libraryReadPath,
  libraryResponseSchemas,
  resolveLibraryRead,
} from '../src'
import { trackPayload } from './fixtures'

/** Synthetic responses only: every name and ID below is invented. */

/** A transport that records each path and answers from `respond`. */
function recordingTransport(respond: (path: string) => unknown) {
  const paths: string[] = []
  return {
    paths,
    transport: async (path: string) => {
      paths.push(path)
      return respond(path)
    },
  }
}

const emptySlice = { items: [], page: 1, size: 24, hasMore: false }

describe('createRemoteLibrarySource', () => {
  it('requests the path the web client builds and parses the data with the method’s schema', async () => {
    const track = trackPayload('track-1').item
    const { paths, transport } = recordingTransport(() => ({
      ...emptySlice,
      items: [track],
      hasMore: true,
    }))
    const source = createRemoteLibrarySource(transport)
    const query = TrackQuerySchema.parse({
      q: 'blue',
      tagLevels: 'album',
      filters: JSON.stringify([{ field: 'genre', value: 'Jazz' }]),
    })
    const result = await source.trackPage(query)
    expect(result).toStrictEqual({
      served: true,
      data: libraryResponseSchemas.trackPage.parse({
        ...emptySlice,
        items: [track],
        hasMore: true,
      }),
    })
    expect(paths).toStrictEqual([libraryReadPath('trackPage', query)])
    expect(resolveLibraryRead(paths[0] ?? '')).toEqual({
      method: 'trackPage',
      query,
    })
  })

  it('applies the response schema’s defaults, as an API read does', async () => {
    const source = createRemoteLibrarySource(async () => [
      { key: 'title', label: 'Title', type: 'text' },
    ])
    expect(await source.fields('album')).toStrictEqual({
      served: true,
      data: [{ key: 'title', label: 'Title', type: 'text', filterable: true }],
    })
  })

  it('calls the route of every method', async () => {
    const { paths, transport } = recordingTransport((path) => {
      if (path.includes('/fields')) return []
      if (path.includes('/facets')) return []
      if (path.includes('/browse-count')) return { totalCount: 4 }
      if (path.includes('/listening-histogram'))
        return { edges: [0, 1], counts: [3, 1] }
      if (path.includes('/positions')) return { items: [] }
      if (path.includes('/browse-page') || path.includes('/recordings'))
        return emptySlice
      return { page: 1, size: 24, totalCount: 0, pageCount: 0, items: [] }
    })
    const source = createRemoteLibrarySource(transport)
    const track = TrackQuerySchema.parse({})
    const album = AlbumQuerySchema.parse({})
    const film = FilmQuerySchema.parse({})
    const artist = ArtistQuerySchema.parse({})
    const facets = BrowseFacetQuerySchema.parse({ q: 'x' })
    const playlist = PlaylistBrowseQuerySchema.parse({})
    const period: ListeningPeriod = { kind: 'all' }
    const results = await Promise.all([
      source.trackPage(track),
      source.trackCount(track),
      source.trackList(track),
      source.trackPositions(
        TrackPositionsQuerySchema.parse({ positions: '1,2' }),
      ),
      source.trackRecordings({ id: 'track 1', query: track }),
      source.trackFacets(facets),
      source.trackHistogram({ ...track, period }),
      source.albumPage(album),
      source.albumCount(album),
      source.albumList(album),
      source.albumFacets(facets),
      source.albumHistogram({ ...album, period }),
      source.filmPage(film),
      source.filmCount(film),
      source.filmList(film),
      source.filmFacets(facets),
      source.artistPage(artist),
      source.artistCount(artist),
      source.artistFacets(facets),
      source.artistHistogram({ ...artist, period }),
      source.playlistPage(playlist),
      source.playlistCount(playlist),
      source.fields('film'),
    ])
    expect(results.every((result) => result.served)).toBe(true)
    expect(paths.map((path) => resolveLibraryRead(path)?.method)).toStrictEqual(
      [
        'trackPage',
        'trackCount',
        'trackList',
        'trackPositions',
        'trackRecordings',
        'trackFacets',
        'trackHistogram',
        'albumPage',
        'albumCount',
        'albumList',
        'albumFacets',
        'albumHistogram',
        'filmPage',
        'filmCount',
        'filmList',
        'filmFacets',
        'artistPage',
        'artistCount',
        'artistFacets',
        'artistHistogram',
        'playlistPage',
        'playlistCount',
        'fields',
      ],
    )
  })

  it('rejects data that does not match the response schema', async () => {
    const source = createRemoteLibrarySource(async () => ({
      totalCount: -1,
    }))
    await expect(
      source.trackCount(TrackQuerySchema.parse({})),
    ).rejects.toBeInstanceOf(ZodError)
    const pages = createRemoteLibrarySource(async () => ({
      ...emptySlice,
      items: [{ id: 'track-1' }],
    }))
    await expect(
      pages.trackPage(TrackQuerySchema.parse({})),
    ).rejects.toBeInstanceOf(ZodError)
    const histograms = createRemoteLibrarySource(async () => ({
      edges: [0, 1],
      counts: [1],
    }))
    await expect(
      histograms.albumHistogram({
        ...AlbumQuerySchema.parse({}),
        period: { kind: 'all' },
      }),
    ).rejects.toBeInstanceOf(ZodError)
  })

  it('propagates transport errors', async () => {
    const failure = new Error('Request failed')
    const source = createRemoteLibrarySource(async () => {
      throw failure
    })
    await expect(
      source.playlistPage(PlaylistBrowseQuerySchema.parse({})),
    ).rejects.toBe(failure)
  })
})
