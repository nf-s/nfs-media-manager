import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type MediaPluginScrapeContext } from '@repo/media-plugin-sdk'
import { ZodError } from 'zod'
import { readAlbumProviderDetails } from '@/lib/album-provider-details'
import { lastfmPlugin } from '../lastfm'
import { lastFmSparseAlbumFixture } from './fixtures/lastfm'

function context(payload: unknown): MediaPluginScrapeContext {
  return {
    mediaItemId: 'canonical-album',
    mediaType: 'album',
    existingReferences: [],
    media: { title: 'Example Album', artists: ['Example Artist'] },
    secrets: { apiKey: 'offline-key' },
    request: vi.fn(async () => Response.json(payload)),
    log: vi.fn(async () => undefined),
  }
}

function scrape(input: MediaPluginScrapeContext) {
  if (!lastfmPlugin.scrapeMediaItem)
    throw new Error('Last.fm scraper not registered')
  return lastfmPlugin.scrapeMediaItem(input)
}

function twoRequests(info: unknown, topTags: unknown) {
  const request = vi
    .fn<MediaPluginScrapeContext['request']>()
    .mockResolvedValueOnce(Response.json(info))
    .mockResolvedValueOnce(Response.json(topTags))
  const input: MediaPluginScrapeContext = {
    ...context(info),
    request,
    secrets: { apiKey: 'offline', username: 'listener' },
    options: { includeTopTags: true },
  }
  return { input, request }
}

describe('Last.fm sparse response boundary', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('No live requests allowed')
      }),
    ),
  )
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, 'true', 1, null])(
    'does not opt in with %j',
    async (option) => {
      const input = context(lastFmSparseAlbumFixture)
      const result = await scrape({
        ...input,
        options: { includeTopTags: option },
      })
      expect(result.payload).toEqual(lastFmSparseAlbumFixture)
      expect(input.request).toHaveBeenCalledTimes(1)
    },
  )

  it('looks up Kid A by owned MBID but requests weighted tags by the returned names', async () => {
    const mbid = '080ad926-7a4e-4399-b7df-0cc1b6ef841c'
    const info = {
      album: {
        ...lastFmSparseAlbumFixture.album,
        name: 'Kid A',
        artist: 'Radiohead',
        url: 'https://www.last.fm/music/Radiohead/Kid+A',
        mbid,
        tags: { tag: [{ name: 'Ambient' }, { name: 'Other' }] },
      },
    }
    const topTagsResponse = {
      toptags: {
        '@attr': { album: 'Kid A', artist: 'Radiohead', mbid },
        tag: [
          { name: ' AMBIENT ', count: '15' },
          {
            name: 'ambient',
            count: '100',
            url: 'https://www.last.fm/tag/ambient',
          },
          { name: 'AMBIENT', count: 90 },
          { name: 'Trip Hop', count: '10' },
          { name: 'noise', count: 9 },
          { name: 'no weight', count: 0 },
        ],
      },
    }
    const { input, request } = twoRequests(info, topTagsResponse)
    const result = await scrape({
      ...input,
      existingReferences: [
        {
          referenceType: 'mbid',
          externalId: mbid,
          isPrimary: true,
          metadata: { sourceProvider: 'lastfm' },
        },
      ],
    })
    expect(request).toHaveBeenCalledTimes(2)
    const first = new URL(String(request.mock.calls[0]?.[0])).searchParams
    expect(first.get('method')).toBe('album.getInfo')
    expect(first.get('mbid')).toBe(mbid)
    const params = new URL(String(request.mock.calls[1]?.[0])).searchParams
    expect(Object.fromEntries(params)).toEqual({
      method: 'album.getTopTags',
      format: 'json',
      api_key: 'offline',
      autocorrect: '1',
      artist: 'Radiohead',
      album: 'Kid A',
    })
    expect(result.payload).toEqual({ ...info, topTagsResponse })
    expect(result.normalized.tags).toEqual(
      ['ambient', 'Other', 'Trip Hop'].map((name) => ({
        name,
        rawName: name,
        source: 'lastfm',
        kind: 'general',
      })),
    )
    const details = readAlbumProviderDetails('lastfm', result.payload)
    expect(details?.tags).toContainEqual({
      name: 'ambient',
      kind: 'album.getTopTags',
      count: 100,
      countLabel: 'weight',
    })
    expect(details?.links).toContainEqual({
      label: 'album.getTopTags: Trip Hop',
      url: 'https://www.last.fm/tag/Trip%20Hop',
    })
    expect(
      result.normalized.mediaPatch?.metadata?.['plugin.lastfm.tagEvidence'],
    ).toContainEqual({
      name: 'ambient',
      rawName: 'ambient',
      source: 'lastfm',
      sourceId: null,
      sourceKind: 'album.getTopTags',
      count: 100,
      url: 'https://www.last.fm/tag/ambient',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses corrected names without a release MBID and accepts an empty identified response', async () => {
    const info = {
      album: {
        ...lastFmSparseAlbumFixture.album,
        artist: { name: 'Correct Artist' },
        name: 'Correct Album',
      },
    }
    const topTagsResponse = {
      toptags: {
        '@attr': { artist: 'Correct Artist', album: 'Correct Album' },
      },
    }
    const { input, request } = twoRequests(info, topTagsResponse)
    const result = await scrape(input)
    const params = new URL(String(request.mock.calls[1]?.[0])).searchParams
    expect(params.get('artist')).toBe('Correct Artist')
    expect(params.get('album')).toBe('Correct Album')
    expect(params.has('username')).toBe(false)
    expect(result.normalized.tags).toEqual([])
    expect(result.payload).toEqual({ ...info, topTagsResponse })
  })

  it('returns only canonical tags for the tag-only pilot and keeps the complete snapshot', async () => {
    const info = {
      album: {
        ...lastFmSparseAlbumFixture.album,
        image: [{ '#text': 'https://example.org/artwork.jpg', size: 'large' }],
        listeners: '123',
      },
    }
    const topTagsResponse = {
      toptags: { tag: [{ name: 'Ambient', count: '80' }] },
    }
    const { input, request } = twoRequests(info, topTagsResponse)
    const result = await scrape({
      ...input,
      options: { includeTopTags: true, tagsOnly: true },
    })
    expect(result.normalized).toStrictEqual({
      tags: [
        {
          name: 'Ambient',
          rawName: 'Ambient',
          source: 'lastfm',
          kind: 'general',
        },
      ],
      references: [],
      links: [],
      credits: [],
      tracks: [],
      playlists: [],
    })
    expect(result.payload).toStrictEqual({ ...info, topTagsResponse })
    const details = readAlbumProviderDetails('lastfm', result.payload)
    expect(details?.tags).toContainEqual({
      name: 'Ambient',
      kind: 'album.getTopTags',
      count: 80,
      countLabel: 'weight',
    })
    expect(details?.tracks).toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps normal getInfo behavior for tagsOnly without includeTopTags', async () => {
    const input = context(lastFmSparseAlbumFixture)
    const result = await scrape({ ...input, options: { tagsOnly: true } })
    expect(result.normalized.tracks).toHaveLength(2)
    expect(result.normalized.mediaPatch).toBeDefined()
    expect(input.request).toHaveBeenCalledTimes(1)
  })

  it.each([
    { tag: [], '@attr': { artist: 'Another artist' } },
    { tag: [], '@attr': { album: 'Another album' } },
    { tag: { name: 'invalid', count: 'unknown' } },
    { tag: { name: 'invalid', count: '101' } },
    { tag: { name: 'invalid', count: 50, url: 'not a URL' } },
    {
      tag: {
        name: 'external',
        count: 50,
        url: 'https://example.org/tag/external',
      },
    },
  ])(
    'rejects invalid dedicated evidence without retries: %j',
    async (toptags) => {
      const { input, request } = twoRequests(lastFmSparseAlbumFixture, {
        toptags,
      })
      await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
      expect(request).toHaveBeenCalledTimes(2)
    },
  )

  it('propagates Last.fm body rate limits from the additional request without retrying', async () => {
    const { input, request } = twoRequests(lastFmSparseAlbumFixture, {
      error: 29,
      message: 'Rate limit exceeded',
    })
    await expect(scrape(input)).rejects.toMatchObject({ code: 'rate-limit' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps the owned release MBID when getInfo omits it and rejects a conflicting echo', async () => {
    const mbid = '61bf0388-b8a9-48f4-81d1-7eb02706dfb0'
    const { input, request } = twoRequests(lastFmSparseAlbumFixture, {
      toptags: {
        tag: [],
        '@attr': { mbid: 'b44fd906-81d4-4808-8300-824612a30350' },
      },
    })
    await expect(
      scrape({
        ...input,
        existingReferences: [
          {
            referenceType: 'mbid',
            externalId: mbid,
            isPrimary: true,
            metadata: { sourceProvider: 'lastfm' },
          },
        ],
      }),
    ).rejects.toThrow('different MBID')
    expect(
      new URL(String(request.mock.calls[1]?.[0])).searchParams.has('mbid'),
    ).toBe(false)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('never requests top tags after getInfo fails', async () => {
    const { input, request } = twoRequests(
      { error: 6, message: 'Album not found' },
      {},
    )
    await expect(scrape(input)).rejects.toThrow('Last.fm album not found')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('propagates a top tags HTTP 400 without a fallback request', async () => {
    const input = context(lastFmSparseAlbumFixture)
    const request = vi
      .fn<MediaPluginScrapeContext['request']>()
      .mockResolvedValueOnce(Response.json(lastFmSparseAlbumFixture))
      .mockResolvedValueOnce(
        Response.json(
          { error: 6, message: 'Invalid parameters' },
          { status: 400 },
        ),
      )
    await expect(
      scrape({
        ...input,
        request,
        options: { includeTopTags: true, tagsOnly: true },
      }),
    ).rejects.toThrow('status 400')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('normalizes the sanitized stored empty tags and null durations without changing raw evidence', async () => {
    const input = context(lastFmSparseAlbumFixture)
    const result = await scrape(input)
    expect(result.payload).toEqual(lastFmSparseAlbumFixture)
    expect(result.normalized.tags).toEqual([])
    expect(result.normalized.tracks).toEqual([
      { title: 'Track 1', position: 1 },
      { title: 'Track 2', position: 2 },
    ])
    expect(result.normalized.mediaPatch?.metadata?.['browse']).toEqual({})
    expect(input.request).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('accepts empty tags independently of missing tracks and retains populated top tags', async () => {
    const result = await scrape(
      context({
        album: {
          ...lastFmSparseAlbumFixture.album,
          tracks: undefined,
          toptags: { tag: [{ name: 'Ambient' }] },
        },
      }),
    )
    expect(result.normalized.tracks).toEqual([])
    expect(result.normalized.tags).toEqual([
      {
        name: 'Ambient',
        kind: 'general',
        source: 'lastfm',
        rawName: 'Ambient',
      },
    ])
  })

  it.each([null, undefined, 0, '0', '123'])(
    'accepts a validated singleton track with duration %j without changing raw evidence',
    async (duration) => {
      // The retained failed-job error identifies an object at album.tracks.track;
      // the failed response body was not stored, so this is synthetic evidence.
      const payload = {
        album: {
          ...lastFmSparseAlbumFixture.album,
          tracks: {
            track: {
              name: 'Only track',
              ...(duration === undefined ? {} : { duration }),
              url: 'https://www.last.fm/music/Example+Artist/_/Only+track',
            },
          },
        },
      }
      const before = structuredClone(payload)
      const input = context(payload)
      const result = await scrape(input)
      expect(result.normalized.tracks).toEqual([
        {
          title: 'Only track',
          position: 1,
          ...(duration === null || duration === undefined
            ? {}
            : { durationSec: Number(duration) }),
        },
      ])
      expect(result.payload).toEqual(before)
      expect(payload).toEqual(before)
      expect(result.normalized.tags).toEqual([])
      const details = readAlbumProviderDetails('lastfm', result.payload)
      expect(details?.tracks).toEqual([
        {
          title: 'Only track',
          position: '1',
          url: payload.album.tracks.track.url,
        },
      ])
      expect(
        result.normalized.mediaPatch?.metadata?.['plugin.lastfm.details'],
      ).toEqual(details)
      expect(input.request).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(
    [
      null,
      '',
      0,
      false,
      {},
      { duration: '123' },
      { name: '' },
      { name: 'Only track', duration: 'invalid' },
      { name: 'Only track', duration: -1 },
      { name: 'Only track', url: 'javascript:alert(1)' },
      [{ name: 'Valid track' }, {}],
    ].map((track) => ({ track })),
  )(
    'rejects malformed singleton or array track data: $track',
    async ({ track }) => {
      const payload = {
        album: { ...lastFmSparseAlbumFixture.album, tracks: { track } },
      }
      const input = context(payload)
      await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
      expect(readAlbumProviderDetails('lastfm', payload)).toBeNull()
      expect(input.request).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps unknown duration absent while preserving zero and valid numeric durations', async () => {
    const durations = [null, undefined, 0, '0', 123, '234']
    const result = await scrape(
      context({
        album: {
          ...lastFmSparseAlbumFixture.album,
          tags: { tag: [] },
          tracks: {
            track: durations.map((duration, index) => ({
              name: `Track ${index + 1}`,
              duration,
            })),
          },
        },
      }),
    )
    expect(result.normalized.tracks).toEqual([
      { title: 'Track 1', position: 1 },
      { title: 'Track 2', position: 2 },
      { title: 'Track 3', position: 3, durationSec: 0 },
      { title: 'Track 4', position: 4, durationSec: 0 },
      { title: 'Track 5', position: 5, durationSec: 123 },
      { title: 'Track 6', position: 6, durationSec: 234 },
    ])
  })

  it.each([
    { tags: 'not empty' },
    { tags: null },
    { tags: [] },
    { tags: { tag: [{ name: '' }] } },
    { tags: { tag: [{ name: 'Ambient', url: 'javascript:void(0)' }] } },
  ])('still rejects malformed tags: $tags', async ({ tags }) => {
    const input = context({
      album: { ...lastFmSparseAlbumFixture.album, tracks: undefined, tags },
    })
    await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
    expect(input.request).toHaveBeenCalledTimes(1)
  })

  it.each([-1, '-1', '', 'unknown', false, {}, 1.5])(
    'still rejects invalid duration %j instead of treating it as unknown',
    async (duration) => {
      const input = context({
        album: {
          ...lastFmSparseAlbumFixture.album,
          tags: { tag: [] },
          tracks: { track: [{ name: 'Track 1', duration }] },
        },
      })
      await expect(scrape(input)).rejects.toBeInstanceOf(ZodError)
      expect(input.request).toHaveBeenCalledTimes(1)
    },
  )
})
